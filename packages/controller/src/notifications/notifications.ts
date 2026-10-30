import { DomainError } from "../domain/errors.js";
import { derivedId } from "../domain/ids.js";
import { onlyKnown, text, type TaskBody, type View } from "../domain/model.js";
import { CommandRunner, view, type RunnerOptions } from "../domain/runner.js";
import { allows } from "../security/access.js";
import { scopedCommandId } from "../security/credentials.js";
import type { NoActor, Principal } from "../security/principals.js";
import { redactText } from "../security/redact.js";
import type { BlockerBody } from "../domain/blockers.js";
import type { InquiryBody } from "../inquiries/inquiries.js";
import type { ReviewBody } from "../review/review.js";
import type { AggregateRef, Change, ControllerStorage, JsonObject } from "../storage/types.js";

/** What can be told to the owner (card U11). */
export const NOTIFICATION_KINDS = ["blocker", "review-request", "owner-question", "maintenance", "presence", "safety-stop"] as const;
export type NotificationKind = (typeof NOTIFICATION_KINDS)[number];

/** The kinds an agent-side producer may report (and only about a record that exists in a project it may report for); the others come from the controller. */
const PRODUCER_KINDS: ReadonlySet<NotificationKind> = new Set(["blocker", "review-request", "owner-question"]);
/** What the owner may answer from a notification, by kind, never by what a producer says. */
const ANSWERS: Readonly<Record<NotificationKind, readonly string[]>> = { blocker: [], "review-request": ["allow", "deny"], "owner-question": [], maintenance: [], presence: [], "safety-stop": [] };

export interface NotificationSettings {
  /** `inbox`: the owner reads the notifications from the controller. `external`: the named channel adapter delivers them as well. Nothing leaves the installation unless this is `external`. */
  readonly channel: "inbox" | "external";
  readonly channelName?: string;
  /** UTC `HH:MM` times at which queued items are collected into a digest. */
  readonly digestTimes: readonly string[];
  /** No digest and no urgent-review message in this span (UTC `HH:MM`, may cross midnight). A blocked critical path and a safety stop still interrupt. */
  readonly quietHours?: { readonly start: string; readonly end: string };
  /** Hours an item that waits on the owner may stay unanswered before the controller raises it to Urgent (card U11b); default 24. */
  readonly escalateAfterHours?: number;
}

export const DEFAULT_ESCALATE_AFTER_HOURS = 24;
/** The kinds that wait on the owner's decision; the others (maintenance, presence) only inform, and a safety stop is Urgent from the start. */
const WAITS_ON_OWNER: ReadonlySet<NotificationKind> = new Set<NotificationKind>(["blocker", "review-request", "owner-question"]);

export interface ItemBody {
  readonly kind: NotificationKind;
  readonly ref: { readonly kind: string; readonly id: string };
  readonly projectId?: string;
  /** Built by the controller from the record the item points to (never taken from the reporter): the only text that goes to an external channel. */
  readonly label: string;
  /** Text from a controller-side reporter, kept in the inbox only. */
  readonly detail?: string;
  readonly reportedBy: string;
  readonly answers: readonly string[];
  readonly immediate: boolean;
  readonly urgent: boolean;
  /** When the controller raised this item to Urgent because it waited too long (card U11b); told once. */
  readonly escalatedAt?: string;
  readonly state: "queued" | "sent" | "answered";
  /** How many times the same event was reported while this item was open. */
  readonly count: number;
  readonly occurrence: number;
  readonly firstAt: string;
  readonly lastAt: string;
  readonly digestId?: string;
  readonly answer?: string;
  readonly answeredAt?: string;
}

export interface DigestBody { readonly createdAt: string; readonly itemIds: readonly string[]; readonly state: "open" | "answered" }
export interface DeliveryBody {
  readonly subject: { readonly kind: "item" | "digest"; readonly id: string };
  readonly channel: string;
  readonly text: string;
  readonly state: "pending" | "delivered" | "failed";
  readonly attempts: number;
  readonly nextAttemptAt?: string;
  readonly lastError?: string;
}
interface StateBody { readonly lastDigestAt?: string }
/** What is open, so nothing has to scan every record ever made: unanswered items, open digests, deliveries waiting, and the latest failed deliveries. */
interface IndexBody { readonly items: readonly string[]; readonly digests: readonly string[]; readonly deliveries: readonly string[]; readonly failed: readonly string[] }

/** An external way to reach the owner. It receives controller-built text and the IDs of the records; nothing else. Delivery is at least once: `deliveryId` lets an adapter drop a repeat. */
export interface ChannelAdapter { send(message: { readonly deliveryId: string; readonly text: string; readonly links: readonly { kind: string; id: string }[] }): Promise<void> }

/**
 * What happens to an answer given from a notification: the service that owns the record decides (for example a review decision). It receives the item (with its revision), the answer and a command ID
 * derived from this answer, so the service can be idempotent, and it must check the record itself: the notification is a pointer, not an authority. Throw to refuse; the item then stays open.
 */
export type Responder = (owner: Principal, item: View<ItemBody>, answer: string, commandId: string) => Promise<void>;

export const NOTIFICATION_LIMITS = { label: 200, detail: 200, retries: 5, retryMinutes: [1, 5, 30, 120, 480] as readonly number[], openItems: 1000, failedKept: 100, digestItems: 50, digestsPerRun: 20, occurrences: 50 } as const;
const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/;
const NAME = /^[a-z][a-z0-9-]{0,39}$/;
const ITEM_ID = /^ntf-[a-z2-7]{20}$/;
const invalid = (field: string, message: string): never => { throw new DomainError("invalid_command", `${field}: ${message}`, { field }); };
const minutesOf = (hhmm: string): number => Number(hhmm.slice(0, 2)) * 60 + Number(hhmm.slice(3));
const DEFAULTS: NotificationSettings = { channel: "inbox", digestTimes: ["09:00"] };
const addMinutes = (iso: string, m: number): string => new Date(Date.parse(iso) + m * 60_000).toISOString();
const EMPTY: IndexBody = { items: [], digests: [], deliveries: [], failed: [] };
const without = (list: readonly string[], id: string): string[] => list.filter((x) => x !== id);
const withId = (list: readonly string[], id: string): string[] => (list.includes(id) ? [...list] : [...list, id]);

export interface Emit extends NoActor {
  readonly kind: NotificationKind;
  /** The record the notification points to. An agent-side producer must name a record that exists, in a project it holds `notification.emit` for. */
  readonly ref: { readonly kind: string; readonly id: string };
  /** Controller-side reports only: extra text kept in the inbox, never sent outside. */
  readonly detail?: string;
  /** A blocker that stops the critical path (interrupts now). Controller only. */
  readonly critical?: boolean;
  /** A review the policy marks urgent (sent at once outside quiet hours; otherwise it waits for the digest or the end of quiet hours). Controller only: a producer does not decide its own urgency. */
  readonly urgent?: boolean;
  /** The project of a controller-side report that has no record to look it up from. */
  readonly projectId?: string;
}

/**
 * Owner notifications (card U11). Reporters send an event pointing at a record; the controller builds the text from the record, the owner's settings decide how it reaches them. Only a blocked
 * critical path and a safety stop interrupt at once (also in quiet hours), and only the controller (an internal call, never a grant) can raise them; an urgent review is sent at once outside quiet hours;
 * everything else is queued and collected into digests at the times the owner sets, outside quiet hours, answerable in one pass. The same event reported again while open coalesces into one item with a
 * count (per project, kind and record); the text and the answers an item offers come from the controller. Delivery goes to the inbox always and to an external channel only when the owner configured one;
 * only the controller-built label leaves the installation. A failed delivery is kept, retried a bounded number of times and listed in the report.
 */
export class NotificationService {
  readonly #runner: CommandRunner;
  readonly #channels: ReadonlyMap<string, ChannelAdapter>;
  readonly #responders: ReadonlyMap<NotificationKind, Responder>;

  private constructor(runner: CommandRunner, channels: ReadonlyMap<string, ChannelAdapter>, responders: ReadonlyMap<NotificationKind, Responder>) {
    this.#runner = runner; this.#channels = channels; this.#responders = responders;
  }

  static withEpoch(storage: ControllerStorage, epoch: number, options: RunnerOptions & { channels?: Record<string, ChannelAdapter>; responders?: Partial<Record<NotificationKind, Responder>> } = {}): NotificationService {
    return new NotificationService(new CommandRunner(storage, epoch, options), new Map(Object.entries(options.channels ?? {})), new Map(Object.entries(options.responders ?? {})) as ReadonlyMap<NotificationKind, Responder>);
  }

  /** The owner sets how notifications reach them (owner only; counts from the next notification). */
  async configure(owner: Principal, command: NoActor & { expectedRevision?: number; channel?: "inbox" | "external"; channelName?: string; digestTimes?: readonly string[]; quietHours?: { start: string; end: string } | null; escalateAfterHours?: number }): Promise<{ revision: number }> {
    if (owner.kind !== "owner") throw new DomainError("forbidden", `${owner.id} is not the owner; only the owner sets how notifications reach them`);
    onlyKnown(command, ["commandId", "expectedRevision", "channel", "channelName", "digestTimes", "quietHours", "escalateAfterHours"]);
    const current = await this.#runner.get("notification-settings", "installation");
    if ((command.expectedRevision ?? 0) !== (current?.revision ?? 0)) throw new DomainError("stale_revision", `notification settings are at revision ${current?.revision ?? 0}, not ${command.expectedRevision ?? 0}`, ...(current === undefined ? [] : [{ currentRevision: current.revision }]));
    const old = (current?.body as unknown as NotificationSettings | undefined) ?? DEFAULTS;
    let next: NotificationSettings = old;
    if (command.channel !== undefined) {
      if (command.channel !== "inbox" && command.channel !== "external") invalid("channel", "must be inbox or external");
      if (command.channel === "external" && (typeof command.channelName !== "string" || !NAME.test(command.channelName))) invalid("channelName", "an external channel needs a name");
      next = { ...next, channel: command.channel, ...(command.channel === "external" ? { channelName: command.channelName! } : {}) };
      if (command.channel === "inbox") { const { channelName: _drop, ...rest } = next; void _drop; next = rest; }
    }
    if (command.digestTimes !== undefined) {
      if (!Array.isArray(command.digestTimes) || command.digestTimes.length < 1 || command.digestTimes.length > 8 || command.digestTimes.some((t) => typeof t !== "string" || !HHMM.test(t))) invalid("digestTimes", "must be 1 to 8 UTC times such as 09:00");
      next = { ...next, digestTimes: [...new Set(command.digestTimes)].sort() };
    }
    if (command.quietHours !== undefined) {
      if (command.quietHours === null) { const { quietHours: _q, ...rest } = next; void _q; next = rest; }
      else {
        const q = command.quietHours;
        if (typeof q !== "object" || typeof q.start !== "string" || typeof q.end !== "string" || !HHMM.test(q.start) || !HHMM.test(q.end) || q.start === q.end) invalid("quietHours", "needs different UTC start and end times such as 22:00 and 07:00");
        next = { ...next, quietHours: { start: q.start, end: q.end } };
      }
    }
    if (command.escalateAfterHours !== undefined) {
      if (!Number.isSafeInteger(command.escalateAfterHours) || command.escalateAfterHours < 1 || command.escalateAfterHours > 24 * 30) invalid("escalateAfterHours", "must be a whole number of hours from 1 to 720");
      next = { ...next, escalateAfterHours: command.escalateAfterHours };
    }
    const ref: AggregateRef = { kind: "notification-settings", id: "installation" };
    const result = await this.#runner.command("notification.configure", { commandId: scopedCommandId(owner.id, command.commandId), actor: owner.id }, async () => ({
      payload: { settings: next as unknown as JsonObject, expectedRevision: current?.revision ?? 0 },
      build: async () => ({ ref, creates: current === undefined, changes: [current === undefined ? { type: "create", ref, body: next as unknown as JsonObject } : { type: "update", ref, expectedRevision: current.revision, body: next as unknown as JsonObject }], detail: { channel: next.channel } }),
    }));
    return { revision: result.revision };
  }

  async settings(owner: Principal): Promise<NotificationSettings & { revision: number }> {
    if (owner.kind !== "owner") throw new DomainError("forbidden", `${owner.id} is not the owner`);
    return this.#settings();
  }

  /**
   * Reports an event. An agent-side producer (`notification.emit`) may report a blocker, a review request or an owner question about a record that exists and belongs to a project it may report for;
   * the text, the project and the answers come from that record and the kind. Safety stops, maintenance, presence, `critical` blockers and detail text come only from the controller (`emitFromController`) or the owner.
   */
  async emit(by: Principal, command: Emit): Promise<{ itemId: string; coalesced: boolean; immediate: boolean }> {
    return this.#emit(by.id, by.kind === "owner", by, command);
  }

  /**
   * The controller's own reports (a safety stop, maintenance, presence, a blocker on the critical path, extra detail text). This is an internal call with no principal, for the dispatcher and the
   * controller's services: it must never be exposed through the state API, and no grant, however broad, gives an agent a way to it.
   */
  async emitFromController(command: Emit & { projectId?: string }): Promise<{ itemId: string; coalesced: boolean; immediate: boolean }> {
    return this.#emit("controller", true, undefined, command);
  }

  async #emit(actor: string, controller: boolean, by: Principal | undefined, command: Emit): Promise<{ itemId: string; coalesced: boolean; immediate: boolean }> {
    onlyKnown(command, ["commandId", "kind", "ref", "detail", "critical", "urgent", "projectId"]);
    if (!NOTIFICATION_KINDS.includes(command.kind)) invalid("kind", `must be one of ${NOTIFICATION_KINDS.join(", ")}`);
    const ref = command.ref;
    // A record ID is a short code, not free text: nothing a reporter writes can ride along in it.
    if (typeof ref !== "object" || ref === null || typeof ref.kind !== "string" || typeof ref.id !== "string" || !/^[a-z][a-z0-9-]{0,40}$/.test(ref.kind) || !/^[a-z0-9][a-z0-9-]{0,40}$/.test(ref.id)) invalid("ref", "must name a record: { kind, id } with short lower-case codes");
    if (command.critical !== undefined && typeof command.critical !== "boolean") invalid("critical", "must be true or false");
    if (command.urgent !== undefined && typeof command.urgent !== "boolean") invalid("urgent", "must be true or false");
    if (command.critical === true && command.kind !== "blocker") invalid("critical", "applies to a blocker only");
    if (command.urgent === true && command.kind !== "review-request") invalid("urgent", "applies to a review request only");
    if (!controller && (!PRODUCER_KINDS.has(command.kind) || command.critical === true || command.urgent === true || command.detail !== undefined || command.projectId !== undefined)) {
      throw new DomainError("forbidden", `${actor} may report blockers, review requests and owner questions about records it can report for; safety stops, maintenance, presence, critical blockers, urgency and extra text are for the controller`);
    }
    const record = await this.#describe(command.kind, ref, command.projectId);
    if (!controller && (by === undefined || record.projectId === undefined || !allows(by, "notification.emit", record.projectId))) throw new DomainError("forbidden", `${actor} may not report notifications about that record`);
    const detail = command.detail === undefined ? undefined : redactText(text(command.detail, "detail", { min: 1, max: NOTIFICATION_LIMITS.detail }));
    const settings = await this.#settings();
    const now = this.#runner.now();
    const interrupts = command.kind === "safety-stop" || command.critical === true;
    const urgent = command.urgent === true;
    const immediate = interrupts || (urgent && !this.#quiet(settings, now));
    const base = `${command.kind}|${record.projectId ?? "-"}|${ref.kind}:${ref.id}`;
    for (let attempt = 1; ; attempt++) {
      try {
        const index = await this.#index();
        // The open occurrence of this event, or the first free one (an answered occurrence stays on record).
        let occurrence = 0; let found: Awaited<ReturnType<CommandRunner["get"]>>;
        for (; occurrence < NOTIFICATION_LIMITS.occurrences; occurrence++) {
          found = await this.#runner.get("notification-item", derivedId("ntf", `${base}|${occurrence}`));
          if (found === undefined || (found.body as unknown as ItemBody).state !== "answered") break;
        }
        if (occurrence >= NOTIFICATION_LIMITS.occurrences) throw new DomainError("unavailable", "this event has been reported and answered too many times to keep separate records");
        const itemId = derivedId("ntf", `${base}|${occurrence}`);
        const old = found?.body as unknown as ItemBody | undefined;
        const coalesced = old !== undefined;
        if (!coalesced && !interrupts && index.body.items.length >= NOTIFICATION_LIMITS.openItems) throw new DomainError("unavailable", `there are ${NOTIFICATION_LIMITS.openItems} unanswered notifications; answer some first`);
        const sendNow = immediate && (!coalesced || old!.state === "queued");
        const body: ItemBody = coalesced
          ? { ...old!, count: old!.count + 1, lastAt: now, immediate: old!.immediate || immediate, urgent: old!.urgent || urgent, ...(sendNow ? { state: "sent" as const } : {}) }
          : { kind: command.kind, ref: { kind: ref.kind, id: ref.id }, ...(record.projectId === undefined ? {} : { projectId: record.projectId }), label: record.label, ...(detail === undefined ? {} : { detail }), reportedBy: actor, answers: [...ANSWERS[command.kind]], immediate, urgent, state: sendNow ? "sent" : "queued", count: 1, occurrence, firstAt: now, lastAt: now };
        const delivery = sendNow ? this.#delivery(settings, { kind: "item", id: itemId }, `${command.kind}: ${record.label}`, now, `${itemId}|${body.firstAt}`) : undefined;
        const itemRef: AggregateRef = { kind: "notification-item", id: itemId };
        await this.#runner.command("notification.emit", { commandId: scopedCommandId(actor, command.commandId), actor }, async () => ({
          payload: { kind: command.kind, ref: { kind: ref.kind, id: ref.id }, critical: command.critical ?? false, urgent, itemId },
          build: async () => ({
            ref: itemRef, creates: found === undefined,
            changes: [
              found === undefined ? { type: "create", ref: itemRef, body: body as unknown as JsonObject } : { type: "update", ref: itemRef, expectedRevision: found.revision, body: body as unknown as JsonObject },
              ...(delivery === undefined ? [] : [{ type: "create" as const, ref: { kind: "notification-delivery", id: delivery.id }, body: delivery.body as unknown as JsonObject }]),
              this.#indexChange(index, { items: withId(index.body.items, itemId), deliveries: delivery !== undefined && delivery.body.state === "pending" ? withId(index.body.deliveries, delivery.id) : index.body.deliveries }),
            ],
            detail: { kind: command.kind, coalesced, immediate: sendNow },
            contention: async () => new DomainError("stale_revision", "the same notification was reported at the same moment"),
          }),
        }));
        return { itemId, coalesced, immediate: sendNow };
      } catch (error) {
        if (!(error instanceof DomainError) || error.code !== "stale_revision" || error.currentRevision !== undefined || attempt >= 8) throw error;
      }
    }
  }

  /**
   * The scheduler's call (an internal call, not exposed through the state API): sends urgent reviews that waited out quiet hours, collects queued items into digests when a digest time has passed
   * outside quiet hours, and tries deliveries that are due. Delivery runs even if collecting fails. Returns what it did.
   */
  async runDue(): Promise<{ digestIds: string[]; delivered: number; failed: number; retrying: number }> {
    const settings = await this.#settings();
    const now = this.#runner.now();
    const digestIds: string[] = [];
    let problem: unknown;
    try {
      if (!this.#quiet(settings, now)) { await this.#escalateStale(settings, now); await this.#releaseUrgent(settings, now); }
      const state = (await this.#runner.get("notification-state", "installation"))?.body as unknown as StateBody | undefined;
      const due = this.#latestDigestTime(settings, now);
      if (due !== undefined && (state?.lastDigestAt === undefined || state.lastDigestAt < due) && !this.#quiet(settings, now)) digestIds.push(...await this.#collect(settings, now, due));
    } catch (error) { problem = error; }
    const delivered = await this.#deliverDue(settings, now);
    if (problem !== undefined) throw problem;
    return { digestIds, ...delivered };
  }

  /** Answers items from a digest in one pass (owner only), each against the revision the owner saw. See `answerItem` for one item. */
  async answerDigest(owner: Principal, command: NoActor & { digestId: string; answers: Readonly<Record<string, { answer: string; revision: number }>> }): Promise<{ answered: string[]; refused: { itemId: string; reason: string }[] }> {
    if (owner.kind !== "owner") throw new DomainError("forbidden", `${owner.id} is not the owner; only the owner answers`);
    onlyKnown(command, ["commandId", "digestId", "answers"]);
    if (typeof command.digestId !== "string" || !/^dgs-[a-z2-7]{20}$/.test(command.digestId)) invalid("digestId", "is not a digest ID");
    if (typeof command.answers !== "object" || command.answers === null || Array.isArray(command.answers)) invalid("answers", "must map item IDs to { answer, revision }");
    const found = await this.#runner.get("notification-digest", command.digestId);
    if (found === undefined) throw new DomainError("not_found", `digest ${command.digestId} does not exist`);
    const digest = found.body as unknown as DigestBody;
    const answered: string[] = []; const refused: { itemId: string; reason: string }[] = [];
    for (const [itemId, given] of Object.entries(command.answers)) {
      if (!digest.itemIds.includes(itemId)) { refused.push({ itemId, reason: "not in this digest" }); continue; }
      try { await this.#answer(owner, { commandId: `${command.commandId}.${itemId}`, itemId, answer: given?.answer, revision: given?.revision }); answered.push(itemId); }
      catch (error) { refused.push({ itemId, reason: error instanceof Error ? redactText(error.message).slice(0, 200) : "refused" }); }
    }
    await this.#closeDigestIfDone(owner, command.digestId, command.commandId);
    return { answered, refused };
  }

  /** Answers one item directly (owner only), for example a safety stop or an urgent review that was sent at once and is in no digest. */
  async answerItem(owner: Principal, command: NoActor & { itemId: string; answer: string; revision: number }): Promise<void> {
    if (owner.kind !== "owner") throw new DomainError("forbidden", `${owner.id} is not the owner; only the owner answers`);
    onlyKnown(command, ["commandId", "itemId", "answer", "revision"]);
    await this.#answer(owner, command);
    const item = (await this.#runner.get("notification-item", command.itemId))?.body as unknown as ItemBody | undefined;
    if (item?.digestId !== undefined) await this.#closeDigestIfDone(owner, item.digestId, command.commandId);
  }

  /** What is waiting for the owner: unanswered items and open digests (owner only). */
  async inbox(owner: Principal): Promise<{ items: View<ItemBody>[]; digests: View<DigestBody>[] }> {
    if (owner.kind !== "owner") throw new DomainError("forbidden", `${owner.id} is not the owner`);
    const index = (await this.#index()).body;
    return { items: await this.#load<ItemBody>("notification-item", index.items), digests: await this.#load<DigestBody>("notification-digest", index.digests) };
  }

  /** Deliveries still waiting, and the latest ones given up on, so a failure is visible (owner only). */
  async report(owner: Principal): Promise<{ pending: View<DeliveryBody>[]; failed: View<DeliveryBody>[] }> {
    if (owner.kind !== "owner") throw new DomainError("forbidden", `${owner.id} is not the owner`);
    const index = (await this.#index()).body;
    return { pending: await this.#load<DeliveryBody>("notification-delivery", index.deliveries), failed: await this.#load<DeliveryBody>("notification-delivery", index.failed) };
  }

  // ---- internals --------------------------------------------------------------------------------------------------------

  async #settings(): Promise<NotificationSettings & { revision: number }> {
    const found = await this.#runner.get("notification-settings", "installation");
    return { ...((found?.body as unknown as NotificationSettings | undefined) ?? DEFAULTS), revision: found?.revision ?? 0 };
  }

  async #index(): Promise<{ revision: number; body: IndexBody }> {
    const found = await this.#runner.get("notification-index", "installation");
    return { revision: found?.revision ?? 0, body: (found?.body as unknown as IndexBody | undefined) ?? EMPTY };
  }

  #indexChange(index: { revision: number; body: IndexBody }, next: Partial<IndexBody>): Change {
    const ref: AggregateRef = { kind: "notification-index", id: "installation" };
    const body = { ...index.body, ...next, failed: (next.failed ?? index.body.failed).slice(-NOTIFICATION_LIMITS.failedKept) } as unknown as JsonObject;
    return index.revision === 0 ? { type: "create", ref, body } : { type: "update", ref, expectedRevision: index.revision, body };
  }

  async #load<B>(kind: string, ids: readonly string[]): Promise<View<B>[]> {
    const out: View<B>[] = [];
    for (const id of ids) { const found = await this.#runner.get(kind, id); if (found !== undefined) out.push(view<B>(found)); }
    return out;
  }

  /** The project and the controller-built label of the record a report points at. A report about a record that does not exist, or is not in the state the kind needs, is refused. */
  async #describe(kind: NotificationKind, ref: { kind: string; id: string }, claimedProject: string | undefined): Promise<{ projectId?: string; label: string }> {
    const missing = (): never => { throw new DomainError("not_found", `no such ${ref.kind} to report about`); };
    if (kind === "review-request") {
      if (ref.kind !== "review") invalid("ref", "a review request points at a review");
      const r = (await this.#runner.get("review", ref.id))?.body as unknown as ReviewBody | undefined ?? missing();
      if (r.state !== "owner-decision") throw new DomainError("invalid_command", "that review is not waiting for the owner", { field: "ref" });
      return { projectId: r.binding.projectId, label: `review of ${r.operation.name} in ${r.binding.projectId} (${ref.id})`.slice(0, NOTIFICATION_LIMITS.label) };
    }
    if (kind === "blocker") {
      if (ref.kind !== "blocker") invalid("ref", "a blocker notification points at a blocker");
      const b = (await this.#runner.get("blocker", ref.id))?.body as unknown as BlockerBody | undefined ?? missing();
      if (b.state !== "open") throw new DomainError("invalid_command", "that blocker is already resolved", { field: "ref" });
      const task = b.subject.kind === "task" ? (await this.#runner.get("task", b.subject.id))?.body as unknown as TaskBody | undefined : undefined;
      return { ...(task === undefined ? {} : { projectId: task.projectId }), label: `${b.type} blocker on ${b.subject.kind} ${b.subject.id} (${ref.id}), waiting for ${b.resolver}`.slice(0, NOTIFICATION_LIMITS.label) };
    }
    if (kind === "owner-question") {
      if (ref.kind !== "inquiry") invalid("ref", "an owner question points at an inquiry");
      const q = (await this.#runner.get("inquiry", ref.id))?.body as unknown as InquiryBody | undefined ?? missing();
      if (q.state !== "open" || !q.to.startsWith("owner:")) throw new DomainError("invalid_command", "that inquiry is not an open question to the owner", { field: "ref" });
      return { projectId: q.projectId, label: `question about task ${q.taskId} in ${q.projectId} (${ref.id})`.slice(0, NOTIFICATION_LIMITS.label) };
    }
    // Controller-side kinds: the reporter names what it is about.
    return { ...(claimedProject === undefined ? {} : { projectId: claimedProject }), label: `${ref.kind} ${ref.id}`.slice(0, NOTIFICATION_LIMITS.label) };
  }

  #quiet(settings: NotificationSettings, now: string): boolean {
    if (settings.quietHours === undefined) return false;
    const t = new Date(now).getUTCHours() * 60 + new Date(now).getUTCMinutes();
    const s = minutesOf(settings.quietHours.start); const e = minutesOf(settings.quietHours.end);
    return s < e ? t >= s && t < e : t >= s || t < e;
  }

  /** The most recent digest time at or before `now`, as a UTC time (today's, or yesterday's if none has passed yet today). */
  #latestDigestTime(settings: NotificationSettings, now: string): string | undefined {
    const day = now.slice(0, 10);
    const times = [...settings.digestTimes].sort();
    const today = times.filter((t) => `${day}T${t}:00.000Z` <= now).pop();
    if (today !== undefined) return `${day}T${today}:00.000Z`;
    const last = times[times.length - 1];
    return last === undefined ? undefined : `${new Date(Date.parse(`${day}T00:00:00.000Z`) - 86_400_000).toISOString().slice(0, 10)}T${last}:00.000Z`;
  }

  #delivery(settings: NotificationSettings, subject: DeliveryBody["subject"], message: string, now: string, key: string): { id: string; body: DeliveryBody } {
    const external = settings.channel === "external" && settings.channelName !== undefined;
    const channel = external ? settings.channelName! : "inbox";
    // The inbox is the controller's own record, so it is delivered as written; an external channel is attempted by `runDue`.
    return { id: derivedId("ndl", `${key}|${channel}`), body: { subject, channel, text: message, state: external ? "pending" : "delivered", attempts: 0, ...(external ? { nextAttemptAt: now } : {}) } };
  }

  /** Mutates state under the index's revision, retrying when another command got there first. */
  async #apply(type: string, meta: { commandId: string; actor: string }, payload: JsonObject, plan: (index: { revision: number; body: IndexBody }) => Promise<{ ref: AggregateRef; creates: boolean; changes: Change[]; detail: JsonObject } | undefined>): Promise<boolean> {
    for (let attempt = 1; ; attempt++) {
      try {
        let ran = false;
        await this.#runner.command(type, meta, async () => ({
          payload,
          build: async () => {
            const index = await this.#index();
            const planned = await plan(index);
            if (planned === undefined) throw new DomainError("not_found", "nothing to do");
            ran = true;
            return { ...planned, contention: async () => new DomainError("stale_revision", "notifications changed at the same moment") };
          },
        }));
        return ran || true;
      } catch (error) {
        if (error instanceof DomainError && error.code === "not_found" && error.message === "nothing to do") return false;
        if (!(error instanceof DomainError) || error.code !== "stale_revision" || error.currentRevision !== undefined || attempt >= 8) throw error;
      }
    }
  }

  /**
   * An item that waits on the owner and has stayed unanswered past the owner's threshold (default 24 hours) is raised to Urgent by the controller and told once, outside quiet hours (card U11b).
   * Nothing but this tick raises it: a producer cannot, and a repeat of the tick or a restart does not tell it again.
   */
  async #escalateStale(settings: NotificationSettings, now: string): Promise<void> {
    const limit = Date.parse(now) - (settings.escalateAfterHours ?? DEFAULT_ESCALATE_AFTER_HOURS) * 3_600_000;
    for (const item of await this.#load<ItemBody>("notification-item", (await this.#index()).body.items)) {
      if (item.state === "answered" || item.escalatedAt !== undefined || !WAITS_ON_OWNER.has(item.kind) || Date.parse(item.firstAt) > limit) continue;
      const hours = Math.floor((Date.parse(now) - Date.parse(item.firstAt)) / 3_600_000);
      const delivery = this.#delivery(settings, { kind: "item", id: item.id }, `URGENT, unanswered for ${hours} hours: ${item.kind}: ${item.label}`, now, `${item.id}|${item.firstAt}|escalated`);
      await this.#apply("notification.escalate", { commandId: `escalate-${item.id}-${item.firstAt}`, actor: "notifications" }, { id: item.id }, async (index) => {
        const current = await this.#runner.get("notification-item", item.id);
        const body = current?.body as unknown as ItemBody | undefined;
        if (current === undefined || body === undefined || body.state === "answered" || body.escalatedAt !== undefined) return undefined;
        const ref: AggregateRef = { kind: "notification-item", id: item.id };
        return { ref, creates: false, changes: [
          { type: "update", ref, expectedRevision: current.revision, body: { ...body, state: "sent", urgent: true, immediate: true, escalatedAt: now } as unknown as JsonObject },
          { type: "create", ref: { kind: "notification-delivery", id: delivery.id }, body: delivery.body as unknown as JsonObject },
          this.#indexChange(index, { deliveries: delivery.body.state === "pending" ? withId(index.body.deliveries, delivery.id) : index.body.deliveries }),
        ], detail: { escalated: true } };
      });
    }
  }

  async #releaseUrgent(settings: NotificationSettings, now: string): Promise<void> {
    for (const item of await this.#load<ItemBody>("notification-item", (await this.#index()).body.items)) {
      if (item.state !== "queued" || !item.urgent) continue;
      const delivery = this.#delivery(settings, { kind: "item", id: item.id }, `${item.kind}: ${item.label}`, now, `${item.id}|${item.firstAt}`);
      await this.#apply("notification.release", { commandId: `release-${item.id}-${item.firstAt}`, actor: "notifications" }, { id: item.id }, async (index) => {
        const current = await this.#runner.get("notification-item", item.id);
        if (current === undefined || (current.body as unknown as ItemBody).state !== "queued") return undefined;
        const ref: AggregateRef = { kind: "notification-item", id: item.id };
        return { ref, creates: false, changes: [
          { type: "update", ref, expectedRevision: current.revision, body: { ...(current.body as unknown as ItemBody), state: "sent", immediate: true } as unknown as JsonObject },
          { type: "create", ref: { kind: "notification-delivery", id: delivery.id }, body: delivery.body as unknown as JsonObject },
          this.#indexChange(index, { deliveries: delivery.body.state === "pending" ? withId(index.body.deliveries, delivery.id) : index.body.deliveries }),
        ], detail: { released: true } };
      });
    }
  }

  async #collect(settings: NotificationSettings, now: string, due: string): Promise<string[]> {
    const ids: string[] = [];
    for (let n = 0; n < NOTIFICATION_LIMITS.digestsPerRun; n++) {
      const queued = (await this.#load<ItemBody>("notification-item", (await this.#index()).body.items)).filter((i) => i.state === "queued" && i.firstAt <= due).sort((a, b) => (a.firstAt < b.firstAt ? -1 : 1)).slice(0, NOTIFICATION_LIMITS.digestItems);
      if (queued.length === 0) break;
      const id = derivedId("dgs", `${due}|${queued.map((i) => i.id).sort().join(",")}`);
      const ref: AggregateRef = { kind: "notification-digest", id };
      const lines = queued.map((i, k) => `${k + 1}. ${i.kind}: ${i.label}${i.count > 1 ? ` (x${i.count})` : ""}`);
      const delivery = this.#delivery(settings, { kind: "digest", id }, `${queued.length} item${queued.length === 1 ? "" : "s"} for you:\n${lines.join("\n")}`, now, `digest|${id}`);
      const body: DigestBody = { createdAt: now, itemIds: queued.map((i) => i.id), state: "open" };
      const ok = await this.#apply("notification.digest", { commandId: `digest-${id}`, actor: "notifications" }, { due, items: body.itemIds.join(",") }, async (index) => {
        // Every item must still be queued at the revision just read.
        const fresh: { id: string; revision: number; body: ItemBody }[] = [];
        for (const q of queued) { const a = await this.#runner.get("notification-item", q.id); if (a === undefined || (a.body as unknown as ItemBody).state !== "queued") return undefined; fresh.push({ id: q.id, revision: a.revision, body: a.body as unknown as ItemBody }); }
        return { ref, creates: true, changes: [
          { type: "create", ref, body: body as unknown as JsonObject },
          { type: "create", ref: { kind: "notification-delivery", id: delivery.id }, body: delivery.body as unknown as JsonObject },
          ...fresh.map((f): Change => ({ type: "update", ref: { kind: "notification-item", id: f.id }, expectedRevision: f.revision, body: { ...f.body, state: "sent", digestId: id } as unknown as JsonObject })),
          this.#indexChange(index, { digests: withId(index.body.digests, id), deliveries: delivery.body.state === "pending" ? withId(index.body.deliveries, delivery.id) : index.body.deliveries }),
        ], detail: { items: queued.length } };
      });
      if (ok) ids.push(id);
    }
    // Everything waiting at that digest time has been collected (or there was nothing): the next digest time is the next chance.
    const stateRef: AggregateRef = { kind: "notification-state", id: "installation" };
    const state = await this.#runner.get("notification-state", "installation");
    await this.#runner.command("notification.digest-time", { commandId: `digest-time-${due}`, actor: "notifications" }, async () => ({
      payload: { due },
      build: async () => ({ ref: stateRef, creates: state === undefined, changes: [state === undefined ? { type: "create", ref: stateRef, body: { lastDigestAt: due } as unknown as JsonObject } : { type: "update", ref: stateRef, expectedRevision: state.revision, body: { lastDigestAt: due } as unknown as JsonObject }], detail: { digests: ids.length } }),
    }));
    return ids;
  }

  async #deliverDue(settings: NotificationSettings, now: string): Promise<{ delivered: number; failed: number; retrying: number }> {
    let delivered = 0; let failed = 0; let retrying = 0;
    for (const d of await this.#load<DeliveryBody>("notification-delivery", (await this.#index()).body.deliveries)) {
      if (d.state !== "pending" || (d.nextAttemptAt ?? now) > now) continue;
      const adapter = this.#channels.get(d.channel);
      let error: string | undefined;
      let permanent = false;
      if (settings.channel !== "external" || settings.channelName !== d.channel) { error = "the channel was changed or switched off after this was queued"; permanent = true; }
      else if (adapter === undefined) error = "no such channel is configured";
      else {
        try { await adapter.send({ deliveryId: d.id, text: d.text, links: [{ kind: d.subject.kind === "item" ? "notification-item" : "notification-digest", id: d.subject.id }] }); }
        catch (e) { error = redactText(e instanceof Error ? e.message : "delivery failed").slice(0, 200); }
      }
      const attempts = d.attempts + 1;
      const base = { subject: d.subject, channel: d.channel, text: d.text };
      const next: DeliveryBody = error === undefined ? { ...base, state: "delivered", attempts }
        : permanent || attempts >= NOTIFICATION_LIMITS.retries ? { ...base, state: "failed", attempts, lastError: error }
        : { ...base, state: "pending", attempts, lastError: error, nextAttemptAt: addMinutes(now, NOTIFICATION_LIMITS.retryMinutes[attempts - 1] ?? 480) };
      const ref: AggregateRef = { kind: "notification-delivery", id: d.id };
      await this.#apply("notification.deliver", { commandId: `deliver-${d.id}-${attempts}`, actor: "notifications" }, { id: d.id, attempts }, async (index) => {
        const current = await this.#runner.get("notification-delivery", d.id);
        if (current === undefined || (current.body as unknown as DeliveryBody).attempts !== d.attempts) return undefined;
        return { ref, creates: false, changes: [
          { type: "update", ref, expectedRevision: current.revision, body: next as unknown as JsonObject },
          this.#indexChange(index, next.state === "pending" ? {} : { deliveries: without(index.body.deliveries, d.id), ...(next.state === "failed" ? { failed: withId(index.body.failed, d.id) } : {}) }),
        ], detail: { state: next.state } };
      });
      if (next.state === "delivered") delivered += 1; else if (next.state === "failed") failed += 1; else retrying += 1;
    }
    return { delivered, failed, retrying };
  }

  async #answer(owner: Principal, command: { commandId: string; itemId: string; answer: unknown; revision: unknown }): Promise<void> {
    if (typeof command.itemId !== "string" || !ITEM_ID.test(command.itemId)) invalid("itemId", "is not a notification ID");
    if (typeof command.answer !== "string") invalid("answer", "must be a word");
    if (typeof command.revision !== "number" || !Number.isSafeInteger(command.revision) || command.revision < 1) invalid("revision", "must be the revision of the item as the owner saw it");
    const answer = command.answer as string; const revision = command.revision as number;
    const aggregate = await this.#runner.get("notification-item", command.itemId);
    if (aggregate === undefined) throw new DomainError("not_found", `notification ${command.itemId} does not exist`);
    const item = aggregate.body as unknown as ItemBody;
    // A repeat of an answer already recorded is answered from the record.
    if (item.state === "answered") { if (item.answer === answer) return; throw new DomainError("invalid_command", "already answered", { field: "answer" }); }
    // What an item means (kind, record, label, answers) never changes after it is made; only its count and state do, so an item that keeps being reported can still be answered from an older view.
    if (revision > aggregate.revision) throw new DomainError("stale_revision", `notification ${command.itemId} is at revision ${aggregate.revision}, not ${revision}`, { currentRevision: aggregate.revision });
    if (!(item.answers.includes(answer) || answer === "ok")) throw new DomainError("invalid_command", `not an answer this item offers (${[...item.answers, "ok"].join(", ")})`, { field: "answer" });
    const responder = this.#responders.get(item.kind);
    if (responder !== undefined && answer !== "ok") await responder(owner, view<ItemBody>(aggregate), answer, scopedCommandId(owner.id, command.commandId));
    await this.#apply("notification.answer", { commandId: scopedCommandId(owner.id, command.commandId), actor: owner.id }, { itemId: command.itemId, answer, revision }, async (index) => {
      const ref: AggregateRef = { kind: "notification-item", id: command.itemId };
      const current = (await this.#runner.get("notification-item", command.itemId))!;
      if ((current.body as unknown as ItemBody).state === "answered") return undefined;
      return { ref, creates: false, changes: [
        { type: "update", ref, expectedRevision: current.revision, body: { ...(current.body as unknown as ItemBody), state: "answered", answer, answeredAt: this.#runner.now() } as unknown as JsonObject },
        this.#indexChange(index, { items: without(index.body.items, command.itemId) }),
      ], detail: { answer } };
    });
  }

  async #closeDigestIfDone(owner: Principal, digestId: string, commandId: string): Promise<void> {
    const digest = (await this.#runner.get("notification-digest", digestId))?.body as unknown as DigestBody | undefined;
    if (digest === undefined || digest.state === "answered") return;
    for (const id of digest.itemIds) if (((await this.#runner.get("notification-item", id))?.body as unknown as ItemBody | undefined)?.state !== "answered") return;
    await this.#apply("notification.digest-done", { commandId: scopedCommandId(owner.id, `${commandId}.done.${digestId}`), actor: owner.id }, { digestId }, async (index) => {
      const current = (await this.#runner.get("notification-digest", digestId))!;
      const ref: AggregateRef = { kind: "notification-digest", id: digestId };
      return { ref, creates: false, changes: [{ type: "update", ref, expectedRevision: current.revision, body: { ...(current.body as unknown as DigestBody), state: "answered" } as unknown as JsonObject }, this.#indexChange(index, { digests: without(index.body.digests, digestId) })], detail: {} };
    });
  }
}
