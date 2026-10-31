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
  /** No digest and no urgent-review message in this span (`HH:MM`, may cross midnight), in the owner's time zone (the `meeting.timeZone` setting) or in UTC when none is set. A blocked critical path and a safety stop still interrupt. */
  readonly quietHours?: { readonly start: string; readonly end: string };
  /** Hours an item that waits on the owner may stay unanswered before the controller raises it to Urgent (card U11b); default 24. */
  readonly escalateAfterHours?: number | null;
  /** Days a Notice stays in the inbox before the controller closes it (card U11b); default 7. */
  readonly noticeRetentionDays?: number;
  /** Most Urgent messages the escalation sweep sends outside per hour (default 10); the rest of a burst is collapsed into ONE "N more items escalated" message. */
  readonly escalationsPerHour?: number;
  /** The least number of seconds between two full sweeps (escalation, settling, expiry) when the dispatcher runs them (default 60). */
  readonly sweepEverySeconds?: number;
  /** Seconds one channel send may take before it is given up on and retried later (default 10). */
  readonly sendTimeoutSeconds?: number;
  /** An escalated Urgent item is sent, and its retries go out, also in quiet hours (default true, as the card says); false: they wait for the end of quiet hours like everything else. */
  readonly urgentInterruptsQuietHours?: boolean;
  /** The owner's own level per kind; it overrides the default level of the kind (a safety stop cannot be set below Urgent). */
  readonly levelByKind?: Readonly<Partial<Record<NotificationKind, NotificationLevel>>>;
}

export const DEFAULT_ESCALATE_AFTER_HOURS = 24;
export const DEFAULT_NOTICE_RETENTION_DAYS = 7;
export const DEFAULT_ESCALATIONS_PER_HOUR = 10;
export const DEFAULT_SWEEP_SECONDS = 60;
export const DEFAULT_SEND_TIMEOUT_SECONDS = 10;
/** The kinds whose record is a pointer the owner answers (a blocker, a review, a question): they are closed when the record is settled elsewhere. */
const WAITS_ON_OWNER: ReadonlySet<NotificationKind> = new Set<NotificationKind>(["blocker", "review-request", "owner-question"]);

/** The three levels of everything that reaches the owner (card U11b, owner decision 2026-10-22). */
export type NotificationLevel = "notice" | "needs-you" | "urgent";
const LEVELS: readonly NotificationLevel[] = ["notice", "needs-you", "urgent"];
const RANK: Readonly<Record<NotificationLevel, number>> = { notice: 0, "needs-you": 1, urgent: 2 };
/**
 * The level a kind has when the controller names none. Exhaustive on purpose: a new kind does not compile until it is placed here. Only presence only informs; maintenance may carry a decision
 * (a budget request, an escalated incident), so a maintenance item is Needs you unless the controller says it is a Notice.
 */
const KIND_LEVEL: Readonly<Record<NotificationKind, NotificationLevel>> = { blocker: "needs-you", "review-request": "needs-you", "owner-question": "needs-you", maintenance: "needs-you", presence: "notice", "safety-stop": "urgent" };

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
  /** The level the controller set when it reported (never from a producer); a missing or unknown value falls back to the safe side, Needs you. */
  readonly level?: NotificationLevel;
  /** When the controller raised this item to Urgent because it waited too long (card U11b); told once. */
  readonly escalatedAt?: string;
  readonly state: "queued" | "sent" | "answered" | "settled";
  /** How many times the same event was reported while this item was open. */
  readonly count: number;
  readonly occurrence: number;
  readonly firstAt: string;
  readonly lastAt: string;
  readonly digestId?: string;
  readonly answer?: string;
  readonly answeredAt?: string;
  /** When the controller closed the item because the record it points at was settled elsewhere (not answered through the inbox). */
  readonly settledAt?: string;
  /** When a Notice was counted in a digest message (a count only; the Notice itself is never pushed). */
  readonly countedAt?: string;
  /** When a Notice was last counted in a digest message that went out (a Notice counted quietly is not yet mentioned). */
  readonly mentionedAt?: string;
}

/**
 * The level of an item, from what the controller set and how it was raised, never from a producer's claim: an interrupting or urgent item is Urgent, otherwise the level the controller named,
 * otherwise the level of its kind. Nothing falls to Notice by accident: a missing level on a kind that is not purely informational is Needs you.
 */
export function levelOf(item: Pick<ItemBody, "kind" | "urgent" | "immediate"> & { readonly level?: NotificationLevel }, owner?: NotificationSettings["levelByKind"]): NotificationLevel {
  if (item.kind === "safety-stop" || item.urgent || item.immediate) return "urgent";
  const chosen = owner?.[item.kind];
  if (chosen !== undefined && LEVELS.includes(chosen)) return chosen;
  if (item.level !== undefined && LEVELS.includes(item.level)) return item.level;
  return KIND_LEVEL[item.kind] ?? "needs-you";
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
  /** An Urgent message (an interruption or an escalation): it also goes out in quiet hours unless the owner switched that off. */
  readonly urgent?: boolean;
}
interface StateBody {
  readonly lastDigestAt?: string;
  /** When the escalation sweep first ran with escalation on. A wait is measured from the later of an item's creation and this, so switching the sweep on for a backlog does not flood the owner. */
  readonly escalationEnabledAt?: string;
  /** The earliest time the next full sweep may run (when the dispatcher runs it); everything before that is a cheap check. */
  readonly nextSweepAt?: string;
  /** The last open item the sweep examined; the next full sweep goes on after it (and starts over at the end). */
  readonly sweepCursor?: string;
  /** Urgent messages the escalation sweep sent in the current hour. */
  readonly urgentWindow?: { readonly startedAt: string; readonly sent: number };
}
/** What is open, so nothing has to scan every record ever made: unanswered items, open digests, deliveries waiting, and the latest failed deliveries. */
interface IndexBody { readonly items: readonly string[]; /** Open Notices, kept apart so they never count against the open-item limit. */ readonly notices?: readonly string[]; readonly digests: readonly string[]; readonly deliveries: readonly string[]; readonly failed: readonly string[] }

/** An external way to reach the owner. It receives controller-built text and the IDs of the records; nothing else. Delivery is at least once: `deliveryId` lets an adapter drop a repeat. */
export interface ChannelAdapter { send(message: { readonly deliveryId: string; readonly text: string; readonly links: readonly { kind: string; id: string }[]; /** Aborted when the send has taken longer than the owner's limit; an adapter that can stop should. */ readonly signal?: AbortSignal }): Promise<void> }

/**
 * What happens to an answer given from a notification: the service that owns the record decides (for example a review decision). It receives the item (with its revision), the answer and a command ID
 * derived from this answer, so the service can be idempotent, and it must check the record itself: the notification is a pointer, not an authority. Throw to refuse; the item then stays open.
 */
export type Responder = (owner: Principal, item: View<ItemBody>, answer: string, commandId: string) => Promise<void>;

export const NOTIFICATION_LIMITS = { label: 200, detail: 200, retries: 5, retryMinutes: [1, 5, 30, 120, 480] as readonly number[], openItems: 1000, openNotices: 500, failedKept: 100, digestItems: 50, digestsPerRun: 20, escalationsPerRun: 25, examinePerRun: 200, deliveriesPerRun: 5, runBudgetMs: 30_000, occurrences: 50 } as const;
// A digest pass must be able to carry every open item (a pass makes at most `digestsPerRun` digests of `digestItems`).
if (NOTIFICATION_LIMITS.digestsPerRun * NOTIFICATION_LIMITS.digestItems < NOTIFICATION_LIMITS.openItems) throw new Error("NOTIFICATION_LIMITS: digestsPerRun * digestItems must be at least openItems");
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

/** Optional wiring: the owner's time zone (quiet hours are read in it; UTC when it gives none), and test overrides for the send timeout and the time one run may take. */
interface ServiceExtras { readonly timeZone?: () => Promise<string | undefined>; readonly sendTimeoutMs?: number; readonly runBudgetMs?: number }

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
  /** The level the controller gives this item (controller only; an agent cannot set it). Default: the level of the kind, Needs you for maintenance. */
  readonly level?: NotificationLevel;
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
  readonly #extra: ServiceExtras;
  #seq = 0;

  private constructor(runner: CommandRunner, channels: ReadonlyMap<string, ChannelAdapter>, responders: ReadonlyMap<NotificationKind, Responder>, extra: ServiceExtras) {
    this.#runner = runner; this.#channels = channels; this.#responders = responders; this.#extra = extra;
  }

  static withEpoch(storage: ControllerStorage, epoch: number, options: RunnerOptions & { channels?: Record<string, ChannelAdapter>; responders?: Partial<Record<NotificationKind, Responder>> } & ServiceExtras = {}): NotificationService {
    const { timeZone, sendTimeoutMs, runBudgetMs } = options;
    return new NotificationService(new CommandRunner(storage, epoch, options), new Map(Object.entries(options.channels ?? {})), new Map(Object.entries(options.responders ?? {})) as ReadonlyMap<NotificationKind, Responder>, { ...(timeZone === undefined ? {} : { timeZone }), ...(sendTimeoutMs === undefined ? {} : { sendTimeoutMs }), ...(runBudgetMs === undefined ? {} : { runBudgetMs }) });
  }

  /** The owner sets how notifications reach them (owner only; counts from the next notification). */
  async configure(owner: Principal, command: NoActor & { expectedRevision?: number; channel?: "inbox" | "external"; channelName?: string; digestTimes?: readonly string[]; quietHours?: { start: string; end: string } | null; escalateAfterHours?: number | null; noticeRetentionDays?: number; escalationsPerHour?: number; sweepEverySeconds?: number; sendTimeoutSeconds?: number; urgentInterruptsQuietHours?: boolean; levelByKind?: Readonly<Record<string, NotificationLevel | null>> }): Promise<{ revision: number }> {
    if (owner.kind !== "owner") throw new DomainError("forbidden", `${owner.id} is not the owner; only the owner sets how notifications reach them`);
    onlyKnown(command, ["commandId", "expectedRevision", "channel", "channelName", "digestTimes", "quietHours", "escalateAfterHours", "noticeRetentionDays", "escalationsPerHour", "sweepEverySeconds", "sendTimeoutSeconds", "urgentInterruptsQuietHours", "levelByKind"]);
    const current = await this.#runner.get("notification-settings", "installation");
    if ((command.expectedRevision ?? 0) !== (current?.revision ?? 0)) throw new DomainError("stale_revision", `notification settings are at revision ${current?.revision ?? 0}, not ${command.expectedRevision ?? 0}`, ...(current === undefined ? [] : [{ currentRevision: current.revision }]));
    const old = (current?.body as unknown as NotificationSettings | undefined) ?? DEFAULTS;
    let next: NotificationSettings = old;
    if (command.channel !== undefined) {
      if (command.channel !== "inbox" && command.channel !== "external") invalid("channel", "must be inbox or external");
      if (command.channel === "external" && (typeof command.channelName !== "string" || !NAME.test(command.channelName))) invalid("channelName", "an external channel needs a name");
      // A channel nobody can deliver through would swallow every message the owner expects outside the inbox: refused here, with the names that do exist.
      if (command.channel === "external" && !this.#channels.has(command.channelName!)) invalid("channelName", `no channel adapter named ${command.channelName} is registered in this installation (registered: ${[...this.#channels.keys()].join(", ") || "none"}); messages stay in the inbox until one is`);
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
        if (typeof q !== "object" || typeof q.start !== "string" || typeof q.end !== "string" || !HHMM.test(q.start) || !HHMM.test(q.end) || q.start === q.end) invalid("quietHours", "needs different start and end times such as 22:00 and 07:00 (read in your time zone setting, or in UTC when none is set)");
        next = { ...next, quietHours: { start: q.start, end: q.end } };
      }
    }
    if (command.escalateAfterHours === null) next = { ...next, escalateAfterHours: null };
    else if (command.escalateAfterHours !== undefined) {
      if (!Number.isSafeInteger(command.escalateAfterHours) || command.escalateAfterHours < 1 || command.escalateAfterHours > 24 * 30) invalid("escalateAfterHours", "must be a whole number of hours from 1 to 720");
      next = { ...next, escalateAfterHours: command.escalateAfterHours };
    }
    if (command.noticeRetentionDays !== undefined) {
      if (!Number.isSafeInteger(command.noticeRetentionDays) || command.noticeRetentionDays < 1 || command.noticeRetentionDays > 365) invalid("noticeRetentionDays", "must be a whole number of days from 1 to 365");
      next = { ...next, noticeRetentionDays: command.noticeRetentionDays };
    }
    const whole = (v: unknown, field: string, lo: number, hi: number, unit: string): number => (typeof v === "number" && Number.isSafeInteger(v) && v >= lo && v <= hi ? v : invalid(field, `must be a whole number of ${unit} from ${lo} to ${hi}`));
    if (command.escalationsPerHour !== undefined) next = { ...next, escalationsPerHour: whole(command.escalationsPerHour, "escalationsPerHour", 1, 1000, "messages") };
    if (command.sweepEverySeconds !== undefined) next = { ...next, sweepEverySeconds: whole(command.sweepEverySeconds, "sweepEverySeconds", 5, 3600, "seconds") };
    if (command.sendTimeoutSeconds !== undefined) next = { ...next, sendTimeoutSeconds: whole(command.sendTimeoutSeconds, "sendTimeoutSeconds", 1, 120, "seconds") };
    if (command.urgentInterruptsQuietHours !== undefined) {
      if (typeof command.urgentInterruptsQuietHours !== "boolean") invalid("urgentInterruptsQuietHours", "must be true or false");
      next = { ...next, urgentInterruptsQuietHours: command.urgentInterruptsQuietHours };
    }
    if (command.levelByKind !== undefined) {
      const given = command.levelByKind;
      if (typeof given !== "object" || given === null || Array.isArray(given)) invalid("levelByKind", "must map kinds to notice, needs-you or urgent (null puts a kind back to its default)");
      const merged: Partial<Record<NotificationKind, NotificationLevel>> = { ...(old.levelByKind ?? {}) };
      for (const [kind, level] of Object.entries(given)) {
        if (!NOTIFICATION_KINDS.includes(kind as NotificationKind)) invalid("levelByKind", `${kind} is not a kind; use ${NOTIFICATION_KINDS.join(", ")}`);
        if (level === null) { delete merged[kind as NotificationKind]; continue; }
        if (!LEVELS.includes(level)) invalid("levelByKind", `${kind}: must be notice, needs-you or urgent`);
        if (kind === "safety-stop" && level !== "urgent") invalid("levelByKind", "a safety stop stays Urgent");
        merged[kind as NotificationKind] = level;
      }
      const { levelByKind: _l, ...rest } = next; void _l;
      next = Object.keys(merged).length === 0 ? rest : { ...rest, levelByKind: merged };
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
    onlyKnown(command, ["commandId", "kind", "ref", "detail", "critical", "urgent", "level", "projectId"]);
    if (!NOTIFICATION_KINDS.includes(command.kind)) invalid("kind", `must be one of ${NOTIFICATION_KINDS.join(", ")}`);
    const ref = command.ref;
    // A record ID is a short code, not free text: nothing a reporter writes can ride along in it.
    if (typeof ref !== "object" || ref === null || typeof ref.kind !== "string" || typeof ref.id !== "string" || !/^[a-z][a-z0-9-]{0,40}$/.test(ref.kind) || !/^[a-z0-9][a-z0-9-]{0,40}$/.test(ref.id)) invalid("ref", "must name a record: { kind, id } with short lower-case codes");
    if (command.critical !== undefined && typeof command.critical !== "boolean") invalid("critical", "must be true or false");
    if (command.urgent !== undefined && typeof command.urgent !== "boolean") invalid("urgent", "must be true or false");
    if (command.level !== undefined && !LEVELS.includes(command.level)) invalid("level", `must be one of ${LEVELS.join(", ")}`);
    if (command.critical === true && command.kind !== "blocker") invalid("critical", "applies to a blocker only");
    if (command.urgent === true && command.kind !== "review-request") invalid("urgent", "applies to a review request only");
    if (!controller && (!PRODUCER_KINDS.has(command.kind) || command.critical === true || command.urgent === true || command.detail !== undefined || command.level !== undefined || command.projectId !== undefined)) {
      throw new DomainError("forbidden", `${actor} may report blockers, review requests and owner questions about records it can report for; safety stops, maintenance, presence, critical blockers, urgency and extra text are for the controller`);
    }
    const record = await this.#describe(command.kind, ref, command.projectId);
    if (!controller && (by === undefined || record.projectId === undefined || !allows(by, "notification.emit", record.projectId))) throw new DomainError("forbidden", `${actor} may not report notifications about that record`);
    const detail = command.detail === undefined ? undefined : redactText(text(command.detail, "detail", { min: 1, max: NOTIFICATION_LIMITS.detail }));
    const settings = await this.#settings();
    const now = this.#runner.now();
    const interrupts = command.kind === "safety-stop" || command.critical === true;
    const level: NotificationLevel = command.level ?? KIND_LEVEL[command.kind];
    // A controller-set Urgent that is not an interruption waits out quiet hours like an urgent review.
    const urgent = command.urgent === true || command.level === "urgent";
    const immediate = interrupts || (urgent && !this.#quiet(settings, now, await this.#zone()));
    const base = `${command.kind}|${record.projectId ?? "-"}|${ref.kind}:${ref.id}`;
    for (let attempt = 1; ; attempt++) {
      try {
        const index = await this.#index();
        // The open occurrence of this event, or the first free one (an answered occurrence stays on record).
        let occurrence = 0; let found: Awaited<ReturnType<CommandRunner["get"]>>;
        for (; occurrence < NOTIFICATION_LIMITS.occurrences; occurrence++) {
          found = await this.#runner.get("notification-item", derivedId("ntf", `${base}|${occurrence}`));
          if (found === undefined || !["answered", "settled"].includes((found.body as unknown as ItemBody).state)) break;
        }
        if (occurrence >= NOTIFICATION_LIMITS.occurrences) throw new DomainError("unavailable", "this event has been reported and answered too many times to keep separate records");
        const itemId = derivedId("ntf", `${base}|${occurrence}`);
        const old = found?.body as unknown as ItemBody | undefined;
        const coalesced = old !== undefined;
        // Notices live in their own list and never count against the limit that guards what needs the owner.
        if (!coalesced && !interrupts && levelOf({ kind: command.kind, urgent, immediate, level }, settings.levelByKind) !== "notice" && index.body.items.length >= NOTIFICATION_LIMITS.openItems) throw new DomainError("unavailable", `there are ${NOTIFICATION_LIMITS.openItems} unanswered notifications; answer some first`);
        const sendNow = immediate && (!coalesced || old!.state === "queued");
        const body: ItemBody = coalesced
          ? { ...old!, count: old!.count + 1, lastAt: now, immediate: old!.immediate || immediate, urgent: old!.urgent || urgent, ...(RANK[level] > RANK[levelOf(old!, settings.levelByKind)] ? { level } : {}), ...(sendNow ? { state: "sent" as const } : {}) }
          : { kind: command.kind, ref: { kind: ref.kind, id: ref.id }, ...(record.projectId === undefined ? {} : { projectId: record.projectId }), label: record.label, ...(detail === undefined ? {} : { detail }), reportedBy: actor, answers: [...ANSWERS[command.kind]], immediate, urgent, level, state: sendNow ? "sent" : "queued", count: 1, occurrence, firstAt: now, lastAt: now };
        const isNotice = levelOf(body, settings.levelByKind) === "notice";
        // At the Notice cap the oldest Notice is closed to make room.
        const openNotices = index.body.notices ?? [];
        const evict = !coalesced && isNotice && openNotices.length >= NOTIFICATION_LIMITS.openNotices ? openNotices[0] : undefined;
        const evicted = evict === undefined ? undefined : await this.#runner.get("notification-item", evict);
        const listed = { items: isNotice ? without(index.body.items, itemId) : withId(index.body.items, itemId), notices: isNotice ? withId(openNotices, itemId) : without(openNotices, itemId) };
        if (evict !== undefined) listed.notices = without(listed.notices, evict);
        const delivery = sendNow ? this.#delivery(settings, { kind: "item", id: itemId }, `${command.kind}: ${record.label}`, now, `${itemId}|${body.firstAt}`, true) : undefined;
        const itemRef: AggregateRef = { kind: "notification-item", id: itemId };
        await this.#runner.command("notification.emit", { commandId: scopedCommandId(actor, command.commandId), actor }, async () => ({
          payload: { kind: command.kind, ref: { kind: ref.kind, id: ref.id }, critical: command.critical ?? false, urgent, itemId },
          build: async () => ({
            ref: itemRef, creates: found === undefined,
            changes: [
              found === undefined ? { type: "create", ref: itemRef, body: body as unknown as JsonObject } : { type: "update", ref: itemRef, expectedRevision: found.revision, body: body as unknown as JsonObject },
              ...(delivery === undefined ? [] : [{ type: "create" as const, ref: { kind: "notification-delivery", id: delivery.id }, body: delivery.body as unknown as JsonObject }]),
              ...(evicted === undefined || (evicted.body as unknown as ItemBody).state === "answered" || (evicted.body as unknown as ItemBody).state === "settled" ? [] : [{ type: "update" as const, ref: { kind: "notification-item", id: evict! }, expectedRevision: evicted.revision, body: { ...(evicted.body as unknown as ItemBody), state: "settled", settledAt: now } as unknown as JsonObject }]),
              this.#indexChange(index, { ...listed, deliveries: delivery !== undefined && delivery.body.state === "pending" ? withId(index.body.deliveries, delivery.id) : index.body.deliveries }),
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
   * The scheduler's call (an internal call, not exposed through the state API): closes what was settled elsewhere, expires Notices, raises unattended Needs-you items, sends urgent reviews that waited out
   * quiet hours, collects queued items into digests when a digest time has passed outside quiet hours, and tries deliveries that are due. Delivery runs even if the rest fails. Returns what it did.
   *
   * Bounded (card U11b review): with `throttled` (the dispatcher's call) the full sweep runs at most every `sweepEverySeconds` (default 60), and only after a look at the state record's next-due time; a
   * full sweep examines at most `examinePerRun` open items from a kept cursor; at most `deliveriesPerRun` sends are tried, each under the send timeout, and nothing new is started once the run has used its time
   * budget. No adapter is called inside a storage transaction. A failure of one item does not stop the others; the first failure is raised after they were tried.
   */
  async runDue(options: { readonly throttled?: boolean } = {}): Promise<{ digestIds: string[]; delivered: number; failed: number; retrying: number }> {
    const settings = await this.#settings();
    const now = this.#runner.now();
    const zone = await this.#zone();
    const started = Date.now();
    const budgetMs = this.#extra.runBudgetMs ?? NOTIFICATION_LIMITS.runBudgetMs;
    const outOfTime = (): boolean => Date.now() - started >= budgetMs;
    const digestIds: string[] = [];
    let problem: unknown;
    let state = await this.#state();
    const quiet = this.#quiet(settings, now, zone);
    const interrupts = settings.urgentInterruptsQuietHours !== false;
    const full = options.throttled !== true || state.nextSweepAt === undefined || state.nextSweepAt <= now;
    if (full) {
      try {
        // The escalation clock: a wait counts from the later of the item's creation and the first time this sweep ran with escalation on, so switching it on for a backlog does not flood the owner.
        if (settings.escalateAfterHours === null && state.escalationEnabledAt !== undefined) state = await this.#patchState((x) => { const { escalationEnabledAt: _e, ...rest } = x; void _e; return rest; });
        else if (settings.escalateAfterHours !== null && state.escalationEnabledAt === undefined) state = await this.#patchState((x) => ({ ...x, escalationEnabledAt: now }));
        const index = await this.#index();
        const open = this.#openIds(index.body);
        const at = state.sweepCursor === undefined ? -1 : open.indexOf(state.sweepCursor);
        const ids = open.slice(at + 1, at + 1 + NOTIFICATION_LIMITS.examinePerRun);
        const cursor = at + 1 + ids.length >= open.length ? undefined : ids[ids.length - 1];
        // Items whose record was settled elsewhere are closed first, so they reach neither an escalation nor a digest; quiet hours do not matter, nothing is told.
        try { await this.#closeSettled(now, ids, outOfTime); } catch (error) { problem = error; }
        // Notices past their retention are closed, whatever the hour.
        try { await this.#expireNotices(settings, now); } catch (error) { problem ??= error; }
        if ((!quiet || interrupts) && !outOfTime()) {
          try { state = await this.#escalateStale(settings, now, ids, state, outOfTime); } catch (error) { problem ??= error; }
        }
        // The next full sweep: not before the interval, and from after the last item examined.
        const wait = (settings.sweepEverySeconds ?? DEFAULT_SWEEP_SECONDS) * 1000;
        state = await this.#patchState((x) => { const { sweepCursor: _c, ...rest } = x; void _c; return { ...rest, nextSweepAt: new Date(Date.parse(now) + wait).toISOString(), ...(cursor === undefined ? {} : { sweepCursor: cursor }) }; });
      } catch (error) { problem ??= error; }
    }
    try {
      if (!quiet && !outOfTime()) await this.#releaseUrgent(settings, now);
      const due = this.#latestDigestTime(settings, now);
      if (due !== undefined && (state.lastDigestAt === undefined || state.lastDigestAt < due) && !quiet && !outOfTime()) digestIds.push(...await this.#collect(settings, now, due));
    } catch (error) { problem ??= error; }
    const delivered = await this.#deliverDue(settings, now, quiet, outOfTime);
    problem ??= delivered.problem;
    if (problem !== undefined) throw problem;
    return { digestIds, delivered: delivered.delivered, failed: delivered.failed, retrying: delivered.retrying };
  }

  async #state(): Promise<StateBody> {
    return ((await this.#runner.get("notification-state", "installation"))?.body as unknown as StateBody | undefined) ?? {};
  }

  /** Changes the state record under its revision, retrying when another command got there first; returns the record as written. */
  async #patchState(change: (state: StateBody) => StateBody, commandId?: string): Promise<StateBody> {
    const ref: AggregateRef = { kind: "notification-state", id: "installation" };
    for (let attempt = 1; ; attempt++) {
      const found = await this.#runner.get("notification-state", "installation");
      const next = change((found?.body as unknown as StateBody | undefined) ?? {});
      try {
        await this.#runner.command("notification.state", { commandId: commandId ?? `state-${this.#runner.now()}-${this.#seq++}-${Math.random().toString(36).slice(2, 8)}`, actor: "notifications" }, async () => ({
          payload: { patch: commandId ?? "state" },
          build: async () => ({ ref, creates: found === undefined, changes: [found === undefined ? { type: "create", ref, body: next as unknown as JsonObject } : { type: "update", ref, expectedRevision: found.revision, body: next as unknown as JsonObject }], detail: {}, contention: async () => new DomainError("stale_revision", "notification state changed at the same moment") }),
        }));
        return next;
      } catch (error) {
        if (!(error instanceof DomainError) || error.code !== "stale_revision" || error.currentRevision !== undefined || attempt >= 8) throw error;
      }
    }
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
    await this.#closeDigestIfDone(owner.id, command.digestId, command.commandId);
    return { answered, refused };
  }

  /** Answers one item directly (owner only), for example a safety stop or an urgent review that was sent at once and is in no digest. */
  async answerItem(owner: Principal, command: NoActor & { itemId: string; answer: string; revision: number }): Promise<void> {
    if (owner.kind !== "owner") throw new DomainError("forbidden", `${owner.id} is not the owner; only the owner answers`);
    onlyKnown(command, ["commandId", "itemId", "answer", "revision"]);
    await this.#answer(owner, command);
    const item = (await this.#runner.get("notification-item", command.itemId))?.body as unknown as ItemBody | undefined;
    if (item?.digestId !== undefined) await this.#closeDigestIfDone(owner.id, item.digestId, command.commandId);
  }

  /** What is waiting for the owner: unanswered items and open digests (owner only). */
  async inbox(owner: Principal): Promise<{ items: (View<ItemBody> & { level: NotificationLevel })[]; digests: View<DigestBody>[] }> {
    if (owner.kind !== "owner") throw new DomainError("forbidden", `${owner.id} is not the owner`);
    const index = (await this.#index()).body;
    const by = (await this.#settings()).levelByKind;
    return { items: (await this.#load<ItemBody>("notification-item", this.#openIds(index))).map((i) => ({ ...i, level: levelOf(i, by) })), digests: await this.#load<DigestBody>("notification-digest", index.digests) };
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

  #openIds(index: IndexBody): string[] { return [...index.items, ...(index.notices ?? [])]; }

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

  /** Whether `now` is inside the owner's quiet hours, read in their time zone (UTC when none is set or it is not a known zone). */
  #quiet(settings: NotificationSettings, now: string, zone?: string): boolean {
    if (settings.quietHours === undefined) return false;
    let t = new Date(now).getUTCHours() * 60 + new Date(now).getUTCMinutes();
    if (zone !== undefined) {
      const parts = new Intl.DateTimeFormat("en-GB", { timeZone: zone, hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).formatToParts(new Date(now));
      t = Number(parts.find((p) => p.type === "hour")?.value ?? "0") * 60 + Number(parts.find((p) => p.type === "minute")?.value ?? "0");
    }
    const s = minutesOf(settings.quietHours.start); const e = minutesOf(settings.quietHours.end);
    return s < e ? t >= s && t < e : t >= s || t < e;
  }

  /** The owner's time zone for quiet hours, or undefined (UTC): none set, unreadable or not a zone this runtime knows. */
  async #zone(): Promise<string | undefined> {
    const z = await this.#extra.timeZone?.().catch(() => undefined);
    if (typeof z !== "string" || z === "") return undefined;
    try { new Intl.DateTimeFormat("en-GB", { timeZone: z }); return z; } catch { return undefined; }
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

  #delivery(settings: NotificationSettings, subject: DeliveryBody["subject"], message: string, now: string, key: string, urgent = false): { id: string; body: DeliveryBody } {
    const external = settings.channel === "external" && settings.channelName !== undefined;
    const channel = external ? settings.channelName! : "inbox";
    // The inbox is the controller's own record, so it is delivered as written; an external channel is attempted by `runDue`.
    return { id: derivedId("ndl", `${key}|${channel}`), body: { subject, channel, text: message, state: external ? "pending" : "delivered", attempts: 0, ...(external ? { nextAttemptAt: now } : {}), ...(urgent ? { urgent: true } : {}) } };
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
   * An item that waits on the owner and has stayed unanswered past the owner's threshold (default 24 hours) is raised to Urgent by the controller and told once (card U11b). Nothing but this tick raises it:
   * a producer cannot, and a repeat of the tick or a restart does not tell it again. Only kinds the owner answers (a blocker, a review, a question) are raised, or a kind the owner set to Needs you; a
   * maintenance item has nobody to wait for unless the producing service closes it (`settleFromController`) or the owner says it matters.
   *
   * The wait is measured from the later of the item's creation and the first time this sweep ran with escalation on, and at most `escalationsPerHour` (default 10) Urgent messages go out in an hour: the items
   * raised beyond that in one run are raised in the inbox but told in ONE "N more items escalated" message (counted as one of the hour's messages); with no message left, nothing is raised until the hour turns.
   * One damaged item does not hold back the others: it is skipped and the first such failure is raised after the rest were tried. Examines only the given slice of open items.
   */
  async #escalateStale(settings: NotificationSettings, now: string, ids: readonly string[], state: StateBody, outOfTime: () => boolean): Promise<StateBody> {
    if (settings.escalateAfterHours === null) return state;
    const after = (settings.escalateAfterHours ?? DEFAULT_ESCALATE_AFTER_HOURS) * 3_600_000;
    const limit = Date.parse(now) - after;
    const since = state.escalationEnabledAt === undefined ? Date.parse(now) : Date.parse(state.escalationEnabledAt);
    let problem: unknown;
    const candidates: View<ItemBody>[] = [];
    // Oldest first, so the oldest wait is never overtaken.
    const loaded = (await this.#load<ItemBody>("notification-item", ids)).sort((a, b) => (a.firstAt < b.firstAt ? -1 : a.firstAt > b.firstAt ? 1 : a.id < b.id ? -1 : 1));
    for (const item of loaded) {
      if (candidates.length >= NOTIFICATION_LIMITS.escalationsPerRun || outOfTime()) break;
      try {
        if (item.state === "answered" || item.state === "settled" || item.escalatedAt !== undefined || levelOf(item, settings.levelByKind) !== "needs-you") continue;
        if (!WAITS_ON_OWNER.has(item.kind) && settings.levelByKind?.[item.kind] !== "needs-you") continue;
        const first = Date.parse(item.firstAt);
        if (!Number.isFinite(first)) throw new DomainError("integrity", `notification ${item.id} has no valid first time`);
        if (Math.max(first, since) > limit) continue;
        // What the item points at may have been settled in its own flow (a blocker resolved, a review decided): a settled record is not raised as Urgent.
        try { await this.#describe(item.kind, item.ref, item.projectId); } catch (error) { if (error instanceof DomainError && (error.code === "not_found" || error.code === "invalid_command")) continue; throw error; }
        candidates.push(item);
      } catch (error) { problem ??= error; }
    }
    // The hour's allowance of Urgent messages.
    const perHour = settings.escalationsPerHour ?? DEFAULT_ESCALATIONS_PER_HOUR;
    const fresh = state.urgentWindow === undefined || Date.parse(now) - Date.parse(state.urgentWindow.startedAt) >= 3_600_000 || Date.parse(now) < Date.parse(state.urgentWindow.startedAt);
    const window = fresh ? { startedAt: now, sent: 0 } : state.urgentWindow!;
    const room = Math.max(0, perHour - window.sent);
    // More candidates than room: room-1 individual messages and one summary for the rest (a single candidate with one message left is just told).
    const individual = candidates.length <= room ? candidates.length : Math.max(0, room - 1);
    const collapsed = candidates.slice(individual);
    if (room === 0) candidates.length = 0;
    const summaryText = collapsed.length === 0 || room === 0 ? undefined : `URGENT: ${collapsed.length} more item${collapsed.length === 1 ? "" : "s"} escalated: unanswered for ${settings.escalateAfterHours ?? DEFAULT_ESCALATE_AFTER_HOURS} hours or more; open your inbox`;
    let sent = 0; let summaryMade = false;
    for (const [n, item] of candidates.entries()) {
      if (outOfTime()) break;
      try {
        const alone = n < individual;
        const hours = Math.floor((Date.parse(now) - Date.parse(item.firstAt)) / 3_600_000);
        const delivery = alone ? this.#delivery(settings, { kind: "item", id: item.id }, `URGENT, unanswered for ${hours} hours: ${item.kind}: ${item.label}`, now, `${item.id}|${item.firstAt}|escalated`, true) : undefined;
        const summary = !alone && !summaryMade && summaryText !== undefined ? this.#delivery(settings, { kind: "item", id: item.id }, summaryText, now, `${item.id}|${item.firstAt}|escalated-summary`, true) : undefined;
        const made = await this.#apply("notification.escalate", { commandId: `escalate-${item.id}-${item.firstAt}`, actor: "notifications" }, { id: item.id }, async (index) => {
          const current = await this.#runner.get("notification-item", item.id);
          const body = current?.body as unknown as ItemBody | undefined;
          if (current === undefined || body === undefined || body.state === "answered" || body.state === "settled" || body.escalatedAt !== undefined) return undefined;
          const ref: AggregateRef = { kind: "notification-item", id: item.id };
          const created = [delivery, summary].filter((x): x is { id: string; body: DeliveryBody } => x !== undefined);
          return { ref, creates: false, changes: [
            { type: "update", ref, expectedRevision: current.revision, body: { ...body, state: "sent", urgent: true, immediate: true, escalatedAt: now } as unknown as JsonObject },
            ...created.map((d): Change => ({ type: "create", ref: { kind: "notification-delivery", id: d.id }, body: d.body as unknown as JsonObject })),
            this.#indexChange(index, { deliveries: created.reduce((list, d) => (d.body.state === "pending" ? withId(list, d.id) : list), index.body.deliveries) }),
          ], detail: { escalated: true } };
        });
        if (made && delivery !== undefined) sent++;
        if (made && summary !== undefined) { summaryMade = true; sent++; }
      } catch (error) { problem ??= error; }
    }
    let next = state;
    if (sent > 0 || fresh) next = await this.#patchState((x) => ({ ...x, urgentWindow: { startedAt: window.startedAt, sent: window.sent + sent } }));
    if (problem !== undefined) throw problem;
    return next;
  }

  /**
   * An item that waits on the owner, whose blocker, review or question was settled in its own flow (resolved, decided, answered elsewhere, gone), is closed as settled and leaves the inbox,
   * so no digest or "needs you" count carries it. A record that cannot be read this time is skipped and tried again on the next tick; the first such failure is raised after the others were tried.
   * Examines only the given open items.
   */
  async #closeSettled(now: string, ids: readonly string[], outOfTime: () => boolean): Promise<void> {
    let problem: unknown;
    for (const item of await this.#load<ItemBody>("notification-item", ids)) {
      if (outOfTime()) break;
      if (item.state === "answered" || item.state === "settled" || !WAITS_ON_OWNER.has(item.kind)) continue;
      try {
        try { await this.#describe(item.kind, item.ref, item.projectId); continue; } catch (error) { if (!(error instanceof DomainError && (error.code === "not_found" || error.code === "invalid_command"))) throw error; }
        await this.#settle(item, now);
      } catch (error) { problem ??= error; }
    }
    if (problem !== undefined) throw problem;
  }

  /** Closes one open item as settled: it leaves the inbox, an external message still waiting for it is dropped (the owner has nothing left to answer), and its digest is closed if that was the last open item. */
  async #settle(item: View<ItemBody>, now: string): Promise<boolean> {
    const waiting = (await this.#load<DeliveryBody>("notification-delivery", (await this.#index()).body.deliveries)).filter((d) => d.subject.kind === "item" && d.subject.id === item.id && d.state === "pending");
    const done = await this.#apply("notification.settle", { commandId: `settle-${item.id}-${item.firstAt}`, actor: "notifications" }, { id: item.id }, async (index) => {
      const current = await this.#runner.get("notification-item", item.id);
      const body = current?.body as unknown as ItemBody | undefined;
      if (current === undefined || body === undefined || body.state === "answered" || body.state === "settled") return undefined;
      const ref: AggregateRef = { kind: "notification-item", id: item.id };
      const dropped: Change[] = [];
      for (const d of waiting) { const cur = await this.#runner.get("notification-delivery", d.id); if (cur !== undefined && (cur.body as unknown as DeliveryBody).state === "pending") dropped.push({ type: "update", ref: { kind: "notification-delivery", id: d.id }, expectedRevision: cur.revision, body: { ...(cur.body as unknown as DeliveryBody), state: "failed", lastError: "the item was settled before this was sent" } as unknown as JsonObject }); }
      return { ref, creates: false, changes: [
        { type: "update", ref, expectedRevision: current.revision, body: { ...body, state: "settled", settledAt: now } as unknown as JsonObject },
        ...dropped,
        this.#indexChange(index, { items: without(index.body.items, item.id), notices: without(index.body.notices ?? [], item.id), deliveries: index.body.deliveries.filter((id) => !waiting.some((d) => d.id === id)) }),
      ], detail: { settled: true } };
    });
    if (item.digestId !== undefined) await this.#closeDigestIfDone("notifications", item.digestId, `settle-${item.id}`);
    return done;
  }

  /**
   * The producing service closes what it reported when the condition is gone (the controller's own call, never exposed through the state API). Kinds the owner does not answer (maintenance, presence) are
   * not closed by the sweep because it cannot tell when they are over; the service that reported them says so here, and the item leaves the inbox and is never escalated. Closes the open occurrence of
   * the event (the same project, kind and record as the report); nothing open is `{ closed: false }`.
   */
  async settleFromController(command: { readonly commandId: string; readonly kind: NotificationKind; readonly ref: { readonly kind: string; readonly id: string }; readonly projectId?: string }): Promise<{ closed: boolean }> {
    if (!NOTIFICATION_KINDS.includes(command.kind)) invalid("kind", `must be one of ${NOTIFICATION_KINDS.join(", ")}`);
    const base = `${command.kind}|${command.projectId ?? "-"}|${command.ref.kind}:${command.ref.id}`;
    for (let occurrence = 0; occurrence < NOTIFICATION_LIMITS.occurrences; occurrence++) {
      const found = await this.#runner.get("notification-item", derivedId("ntf", `${base}|${occurrence}`));
      if (found === undefined) return { closed: false };
      const item = view<ItemBody>(found);
      if (item.state === "answered" || item.state === "settled") continue;
      return { closed: await this.#settle(item, this.#runner.now()) };
    }
    return { closed: false };
  }

  /** A Notice that has stayed in the inbox past the retention (default 7 days since it was last reported) is closed as settled; nobody had to answer it. */
  async #expireNotices(settings: NotificationSettings, now: string): Promise<void> {
    const limit = new Date(Date.parse(now) - (settings.noticeRetentionDays ?? DEFAULT_NOTICE_RETENTION_DAYS) * 86_400_000).toISOString();
    const old = (await this.#load<ItemBody>("notification-item", (await this.#index()).body.notices ?? [])).filter((i) => levelOf(i, settings.levelByKind) === "notice" && i.lastAt <= limit && i.state !== "answered" && i.state !== "settled");
    for (let k = 0; k < old.length; k += 90) {
      const chunk = old.slice(k, k + 90);
      await this.#apply("notification.expire-notices", { commandId: `expire-${chunk[0]!.id}-${chunk[0]!.lastAt}-${chunk.length}`, actor: "notifications" }, { ids: chunk.map((i) => i.id).join(",") }, async (index) => {
        const changes: Change[] = [];
        const closed: string[] = [];
        for (const c of chunk) {
          const cur = await this.#runner.get("notification-item", c.id);
          const b = cur?.body as unknown as ItemBody | undefined;
          if (cur === undefined || b === undefined || b.state === "answered" || b.state === "settled" || b.lastAt > limit) continue;
          changes.push({ type: "update", ref: { kind: "notification-item", id: c.id }, expectedRevision: cur.revision, body: { ...b, state: "settled", settledAt: now } as unknown as JsonObject });
          closed.push(c.id);
        }
        if (changes.length === 0) return undefined;
        return { ref: { kind: "notification-item", id: closed[0]! }, creates: false, changes: [...changes, this.#indexChange(index, { notices: (index.body.notices ?? []).filter((x) => !closed.includes(x)) })], detail: { expired: closed.length } };
      });
    }
  }

  async #releaseUrgent(settings: NotificationSettings, now: string): Promise<void> {
    for (const item of await this.#load<ItemBody>("notification-item", this.#openIds((await this.#index()).body))) {
      if (item.state !== "queued" || !item.urgent) continue;
      const delivery = this.#delivery(settings, { kind: "item", id: item.id }, `${item.kind}: ${item.label}`, now, `${item.id}|${item.firstAt}`, true);
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
      const open = await this.#load<ItemBody>("notification-item", this.#openIds((await this.#index()).body));
      const waiting = open.filter((i) => i.state === "queued" && i.firstAt <= due).sort((a, b) => (a.firstAt < b.firstAt ? -1 : 1));
      // A Notice is never listed or pushed: it stays in the inbox and is only counted in the digest message (card U11b). Every Notice waiting is counted in this pass, and the Notices
      // that were counted quietly earlier (no digest went out) are carried into the first message that does go out, so the number told is the true total.
      const queued = waiting.filter((i) => levelOf(i, settings.levelByKind) !== "notice").slice(0, NOTIFICATION_LIMITS.digestItems);
      const notices = waiting.filter((i) => levelOf(i, settings.levelByKind) === "notice");
      const carried = open.filter((i) => levelOf(i, settings.levelByKind) === "notice" && i.state !== "answered" && i.state !== "settled" && i.countedAt !== undefined && i.mentionedAt === undefined);
      if (queued.length === 0 && notices.length === 0) break;
      const told = queued.length === 0 ? [] : [...notices, ...carried];
      const id = derivedId("dgs", `${due}|${queued.map((i) => i.id).sort().join(",")}${notices.length === 0 ? "" : `|n:${notices.map((i) => i.id).sort().join(",")}`}`);
      const ref: AggregateRef = { kind: "notification-digest", id };
      const lines = queued.map((i, k) => `${k + 1}. ${i.kind}: ${i.label}${i.count > 1 ? ` (x${i.count})` : ""}`);
      const noticeLine = told.length === 0 ? "" : `\n${told.length} notice${told.length === 1 ? "" : "s"} in your inbox, no action needed.`;
      const delivery = queued.length === 0 ? undefined : this.#delivery(settings, { kind: "digest", id }, `${queued.length} item${queued.length === 1 ? "" : "s"} for you:\n${lines.join("\n")}${noticeLine}`, now, `digest|${id}`);
      const body: DigestBody = { createdAt: now, itemIds: queued.map((i) => i.id), state: "open" };
      // One command holds at most 100 changes: the digest takes as many Notices as fit, the rest are marked right after in commands of their own (each marks only what is still unmarked, so a
      // repeat or a crash in between at worst tells a Notice once more, never fewer than the truth).
      const marking = [...notices, ...(queued.length === 0 ? [] : carried)];
      const room = queued.length === 0 ? 90 : 40;
      const mark = async (list: readonly { readonly id: string }[]): Promise<Change[]> => {
        const out: Change[] = [];
        for (const q of list) {
          const a = await this.#runner.get("notification-item", q.id); const cur = a?.body as unknown as ItemBody | undefined;
          if (a === undefined || cur === undefined || cur.state === "answered" || cur.state === "settled") continue;
          const was = cur.countedAt !== undefined;
          if (cur.state === "queued" || (queued.length > 0 && cur.mentionedAt === undefined)) out.push({ type: "update", ref: { kind: "notification-item", id: q.id }, expectedRevision: a.revision, body: { ...cur, state: "sent", countedAt: was ? cur.countedAt! : now, ...(queued.length === 0 ? {} : { mentionedAt: now }) } as unknown as JsonObject });
        }
        return out;
      };
      const ok = await this.#apply(queued.length === 0 ? "notification.notices-counted" : "notification.digest", { commandId: queued.length === 0 ? `notices-${id}` : `digest-${id}`, actor: "notifications" }, { due, items: body.itemIds.join(","), notices: notices.slice(0, room).map((i) => i.id).join(",") }, async (index) => {
        // Every item must still be queued at the revision just read.
        const fresh: { id: string; revision: number; body: ItemBody }[] = [];
        for (const q of queued) { const a = await this.#runner.get("notification-item", q.id); if (a === undefined || (a.body as unknown as ItemBody).state !== "queued") return undefined; fresh.push({ id: q.id, revision: a.revision, body: a.body as unknown as ItemBody }); }
        const counted = await mark(marking.slice(0, room));
        if (queued.length === 0 && counted.length === 0) return undefined;
        return { ref: delivery === undefined ? counted[0]!.ref : ref, creates: delivery !== undefined, changes: [
          ...(delivery === undefined ? [] : [{ type: "create" as const, ref, body: body as unknown as JsonObject }, { type: "create" as const, ref: { kind: "notification-delivery", id: delivery.id }, body: delivery.body as unknown as JsonObject }]),
          ...fresh.map((f): Change => ({ type: "update", ref: { kind: "notification-item", id: f.id }, expectedRevision: f.revision, body: { ...f.body, state: "sent", digestId: id } as unknown as JsonObject })),
          ...counted,
          this.#indexChange(index, delivery === undefined ? {} : { digests: withId(index.body.digests, id), deliveries: delivery.body.state === "pending" ? withId(index.body.deliveries, delivery.id) : index.body.deliveries }),
        ], detail: { items: queued.length, notices: told.length } };
      });
      if (ok) {
        for (let k = room; k < marking.length; k += 90) {
          const chunk = marking.slice(k, k + 90);
          await this.#apply("notification.notices-marked", { commandId: `marked-${id}-${k}`, actor: "notifications" }, { due, from: k }, async () => {
            const changes = await mark(chunk);
            return changes.length === 0 ? undefined : { ref: changes[0]!.ref, creates: false, changes, detail: { notices: changes.length } };
          });
        }
      }
      if (ok && delivery !== undefined) ids.push(id);
    }
    // Everything waiting at that digest time has been collected (or there was nothing): the next digest time is the next chance.
    await this.#patchState((x) => ({ ...x, lastDigestAt: due }), `digest-time-${due}`);
    return ids;
  }

  /**
   * Tries the deliveries that are due, at most `deliveriesPerRun` a run and each under the send timeout: an adapter that hangs costs one timeout, never the run (and the dispatcher's tick) with it. Adapters
   * are called with no storage transaction open. A quiet-hours hold applies to everything but Urgent messages (unless the owner switched that off). A delivery given up on after its retries tells the owner once
   * (a Needs-you maintenance item that coalesces while it is open), because a message that never arrives is otherwise silent.
   */
  async #deliverDue(settings: NotificationSettings, now: string, quiet: boolean, outOfTime: () => boolean): Promise<{ delivered: number; failed: number; retrying: number; problem?: unknown }> {
    let delivered = 0; let failed = 0; let retrying = 0; let tried = 0; let problem: unknown;
    const timeoutMs = this.#extra.sendTimeoutMs ?? (settings.sendTimeoutSeconds ?? DEFAULT_SEND_TIMEOUT_SECONDS) * 1000;
    for (const d of await this.#load<DeliveryBody>("notification-delivery", (await this.#index()).body.deliveries)) {
      if (d.state !== "pending" || (d.nextAttemptAt ?? now) > now) continue;
      if (quiet && !(d.urgent === true && settings.urgentInterruptsQuietHours !== false)) continue;
      if (tried >= NOTIFICATION_LIMITS.deliveriesPerRun || outOfTime()) break;
      tried++;
      const adapter = this.#channels.get(d.channel);
      let error: string | undefined;
      let permanent = false;
      if (settings.channel !== "external" || settings.channelName !== d.channel) { error = "the channel was changed or switched off after this was queued"; permanent = true; }
      else if (adapter === undefined) error = "no such channel is configured";
      else {
        try { await this.#send(adapter, { deliveryId: d.id, text: d.text, links: [{ kind: d.subject.kind === "item" ? "notification-item" : "notification-digest", id: d.subject.id }] }, timeoutMs); }
        catch (e) { error = redactText(e instanceof Error ? e.message : "delivery failed").slice(0, 200); }
      }
      const attempts = d.attempts + 1;
      const base = { subject: d.subject, channel: d.channel, text: d.text, ...(d.urgent === true ? { urgent: true } : {}) };
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
      if (next.state === "failed" && !permanent) {
        // One notice at a time: a further failure while it is open coalesces into it.
        try { await this.#emit("controller", true, undefined, { commandId: `delivery-failed-${d.id}`, kind: "maintenance", level: "needs-you", ref: { kind: "notification-delivery", id: "failed" }, detail: `A message to you through ${d.channel} could not be delivered after ${attempts} tries (${error}). Check the channel, then answer this.` }); } catch (e) { problem ??= e; }
      }
    }
    return { delivered, failed, retrying, ...(problem === undefined ? {} : { problem }) };
  }

  /** One send under a time limit; the send is told to stop (abort signal) and abandoned when the limit passes. */
  async #send(adapter: ChannelAdapter, message: { deliveryId: string; text: string; links: readonly { kind: string; id: string }[] }, timeoutMs: number): Promise<void> {
    const stop = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const sending = Promise.resolve().then(() => adapter.send({ ...message, signal: stop.signal }));
    sending.catch(() => undefined);
    try {
      await Promise.race([sending, new Promise<never>((_, reject) => { timer = setTimeout(() => { stop.abort(); reject(new Error(`the channel did not answer within ${Math.max(1, Math.round(timeoutMs / 1000))} seconds`)); }, timeoutMs); })]);
    } finally { if (timer !== undefined) clearTimeout(timer); }
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
    if (item.state === "settled") throw new DomainError("invalid_command", "that item was settled elsewhere and is closed", { field: "itemId" });
    // What an item means (kind, record, label, answers) never changes after it is made; only its count and state do, so an item that keeps being reported can still be answered from an older view.
    if (revision > aggregate.revision) throw new DomainError("stale_revision", `notification ${command.itemId} is at revision ${aggregate.revision}, not ${revision}`, { currentRevision: aggregate.revision });
    if (!(item.answers.includes(answer) || answer === "ok")) throw new DomainError("invalid_command", `not an answer this item offers (${[...item.answers, "ok"].join(", ")})`, { field: "answer" });
    const responder = this.#responders.get(item.kind);
    if (responder !== undefined && answer !== "ok") await responder(owner, view<ItemBody>(aggregate), answer, scopedCommandId(owner.id, command.commandId));
    await this.#apply("notification.answer", { commandId: scopedCommandId(owner.id, command.commandId), actor: owner.id }, { itemId: command.itemId, answer, revision }, async (index) => {
      const ref: AggregateRef = { kind: "notification-item", id: command.itemId };
      const current = (await this.#runner.get("notification-item", command.itemId))!;
      if ((current.body as unknown as ItemBody).state === "answered" || (current.body as unknown as ItemBody).state === "settled") return undefined;
      return { ref, creates: false, changes: [
        { type: "update", ref, expectedRevision: current.revision, body: { ...(current.body as unknown as ItemBody), state: "answered", answer, answeredAt: this.#runner.now() } as unknown as JsonObject },
        this.#indexChange(index, { items: without(index.body.items, command.itemId), notices: without(index.body.notices ?? [], command.itemId) }),
      ], detail: { answer } };
    });
  }

  async #closeDigestIfDone(actorId: string, digestId: string, commandId: string): Promise<void> {
    const digest = (await this.#runner.get("notification-digest", digestId))?.body as unknown as DigestBody | undefined;
    if (digest === undefined || digest.state === "answered") return;
    for (const id of digest.itemIds) { const state = ((await this.#runner.get("notification-item", id))?.body as unknown as ItemBody | undefined)?.state; if (state !== "answered" && state !== "settled") return; }
    await this.#apply("notification.digest-done", { commandId: scopedCommandId(actorId, `${commandId}.done.${digestId}`), actor: actorId }, { digestId }, async (index) => {
      const current = (await this.#runner.get("notification-digest", digestId))!;
      const ref: AggregateRef = { kind: "notification-digest", id: digestId };
      return { ref, creates: false, changes: [{ type: "update", ref, expectedRevision: current.revision, body: { ...(current.body as unknown as DigestBody), state: "answered" } as unknown as JsonObject }, this.#indexChange(index, { digests: without(index.body.digests, digestId) })], detail: {} };
    });
  }
}
