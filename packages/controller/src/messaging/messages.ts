import type { AssignmentService } from "../domain/assignments.js";
import { DomainError } from "../domain/errors.js";
import { derivedId } from "../domain/ids.js";
import { onlyKnown, taskId as checkTaskId, text, type TaskBody, type View } from "../domain/model.js";
import { CommandRunner, view, type RunnerOptions } from "../domain/runner.js";
import { WAIT_LIMITS, type WaitService } from "../domain/waits.js";
import type { Availability } from "../conversations/index.js";
import type { InquiryBody, InquiryService } from "../inquiries/inquiries.js";
import type { MeetingService } from "../meetings/meetings.js";
import type { NotificationService } from "../notifications/notifications.js";
import { allows, inTaskScope } from "../security/access.js";
import { scopedCommandId } from "../security/credentials.js";
import { effectiveOf } from "../security/grants.js";
import type { NoActor, Principal, PrincipalBody } from "../security/principals.js";
import { redactText } from "../security/redact.js";
import type { Aggregate, AggregateRef, Change, ControllerStorage, JsonObject } from "../storage/types.js";

/**
 * How a message is delivered (README 485-491). The sender chooses a class; the controller decides whether the sender may and what actually happens.
 * - `informational`: batched, read at the next check-in or stand-up.
 * - `advice`: an advice or an ordinary request, read at the next safe task boundary.
 * - `blocking-dependency`: wakes the recipient's task if (and only if) it waits for exactly this sender on a dependency wait; never through a pause.
 * - `urgent-control`: asks for a safe interruption; needs the sender's own `message.urgent` authority (the owner has it) and is limited by the recipient's interruption allowance.
 */
export type DeliveryClass = "informational" | "advice" | "blocking-dependency" | "urgent-control";
export const DELIVERY_CLASSES: readonly DeliveryClass[] = ["informational", "advice", "blocking-dependency", "urgent-control"];
/** The urgency a class carries. It is derived from the class and the sender's authority, never chosen separately, so a sender's rank cannot make a message urgent. It maps onto the owner-facing levels of U11b (`low`, `normal` are notices, `high` needs a person, `urgent` interrupts). */
export type Urgency = "low" | "normal" | "high" | "urgent";
const URGENCY: Readonly<Record<DeliveryClass, Urgency>> = { informational: "low", advice: "normal", "blocking-dependency": "high", "urgent-control": "urgent" };
/** `notice`: no answer expected. `request`: an answer is expected (a deadline may be set). `reply`: the answer to a request. `escalation`: written by the controller when a request's deadline passes. */
export type AgentMessageKind = "notice" | "request" | "reply" | "escalation";
/**
 * Accepting is one atomic step, so there is no stored "sending" state: a sender whose call did not return repeats it with the same command ID and gets the recorded result.
 * `accepted`: kept for the recipient. `delivered`: the recipient confirmed receiving it at a boundary (or it woke the waiting task). `handled`: the recipient says it dealt with it. `answered`: a reply was sent.
 */
export type AgentMessageState = "accepted" | "delivered" | "handled" | "answered";
/** What the recipient's lifecycle allowed when the message was accepted, and (in a view) allows now. */
export type Reach = "ready" | "queued" | "unavailable";
export type MessageBoundary = "check-in" | "stand-up" | "safe-boundary" | "interrupt";
const BOUNDARIES: readonly MessageBoundary[] = ["check-in", "stand-up", "safe-boundary", "interrupt"];
/** Which classes each boundary may deliver. A blocking dependency is never read at a boundary: it wakes its task (or is downgraded to advice). */
const AT: Readonly<Record<MessageBoundary, readonly DeliveryClass[]>> = {
  "check-in": ["informational", "advice"], "stand-up": ["informational", "advice"], "safe-boundary": ["advice"], interrupt: ["urgent-control"],
};

/** Provisional limits, adjustable. `allowance` is the number of interruptions a recipient accepts per window from senders other than the owner. */
export const MESSAGE_LIMITS = {
  purpose: 200, text: 4000, queue: 100, escalationReserve: 20, urgentReserve: 20, ownerReserve: 20, ownerDeadlineReserve: 50, perSenderQueue: 20, perMinute: 30, perRecipientPerMinute: 10, depth: 8,
  allowance: 3, allowanceWindowMinutes: 60, focusMaxMinutes: 240, deadlineMaxDays: 30, openDeadlines: 1000, openDeadlinesPerSender: 20, page: 100, batch: 50, key: 80, question: 4000,
} as const;

const MESSAGE_ID = /^amg-[a-z2-7]{20}$/;
const PRINCIPAL = /^(?:owner|agent):[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const CORRELATION = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,79}$/;
const KEY = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,79}$/;
const TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const OCCURRENCE = /^mto-[a-z2-7]{20}$/;
const SYSTEM = "controller";
const RATE_WINDOW_MS = 60_000;
const invalid = (field: string, message: string): never => { throw new DomainError("invalid_command", `${field}: ${message}`, { field }); };
const plain = (value: unknown, field: string, max: number): string => {
  const out = text(value, field, { min: 1, max, multiline: true });
  if (redactText(out) !== out) invalid(field, "looks like a credential or key; those are not recorded");
  return out;
};
const inboxIdOf = (principalId: string): string => principalId;
/** The text a wake writes into the wait it answers. It names the message, so a repeat can tell its own answer from another's. */
const wakeAnswer = (messageId: string, purpose: string, body: string): string => `[${messageId}] ${purpose}: ${body}`;
const addMs = (iso: string, ms: number): string => new Date(Date.parse(iso) + ms).toISOString();

export interface AgentMessageBody {
  readonly taskId: string;
  readonly projectId: string;
  /** The authenticated sender (or `controller` for an escalation). Nothing in the content can change it. */
  readonly sender: string;
  readonly to: string;
  readonly kind: AgentMessageKind;
  /** Why the recipient is getting this. */
  readonly purpose: string;
  readonly text: string;
  /** The class the sender asked for, and the class applied. They differ only when `downgraded` says why. */
  readonly class: DeliveryClass;
  readonly effectiveClass: DeliveryClass;
  readonly downgraded?: "no_eligible_wait" | "interruption_allowance" | "sender_authority_lost";
  readonly urgency: Urgency;
  readonly correlationId: string;
  readonly replyTo?: string;
  readonly depth: number;
  readonly deadline?: string;
  readonly escalateTo?: string;
  readonly escalatedAt?: string;
  readonly escalationId?: string;
  readonly state: AgentMessageState;
  /** `queued` or `unavailable` when the recipient could not take it at once; nothing here ever resumes the recipient. */
  readonly reach: Reach;
  /** Repeated updates with the same key replace the text of the one waiting message and count here (1: sent once). */
  readonly coalesceKey?: string;
  readonly count: number;
  readonly sentAt: string;
  readonly lastAt: string;
  readonly deliveredAt?: string;
  /** The delivery was a wake of the waiting task (blocking dependency), or an interruption. */
  readonly via?: "wake" | "interrupt" | MessageBoundary;
  readonly handledAt?: string;
  readonly answeredAt?: string;
  readonly replyId?: string;
}

interface PendingEntry { readonly id: string; readonly class: DeliveryClass; readonly sender: string; readonly taskId: string; readonly key?: string; readonly at: string }
interface InboxBody {
  /** Accepted messages the recipient has not yet confirmed. At most `queue` + `urgentReserve` + `escalationReserve` (the owner's and authorized interruptions' reserve, then escalations'), so reading it is never a truncated scan. */
  readonly pending: readonly PendingEntry[];
  /** When the interruptions accepted in the last allowance window were accepted (a rolling window: older ones are dropped). */
  readonly interrupts: { readonly times: readonly string[] };
  readonly focus?: { readonly until: string; readonly setBy: string; readonly reason: string };
}
interface RateBody { readonly windowStart: string; readonly count: number; readonly perRecipient: Readonly<Record<string, number>> }
interface DeadlineIndex { readonly open: readonly { readonly id: string; readonly sender: string }[] }

export interface SendAgentMessage extends NoActor {
  /** Required unless `replyTo` is given (a reply is about the task of the message it answers). */
  readonly taskId?: string;
  /** Required unless `replyTo` is given (a reply goes to the sender of the message it answers). */
  readonly to?: string;
  readonly class: DeliveryClass;
  readonly purpose: string;
  readonly text: string;
  /** An answer is expected. A deadline needs it. */
  readonly expectsReply?: boolean;
  readonly deadline?: string;
  /** Who is told if the request has no reply at its deadline. Required with a deadline. */
  readonly escalateTo?: string;
  readonly replyTo?: string;
  readonly correlationId?: string;
  /** Repeated updates (same sender, task and key) replace the text of the one waiting message instead of queueing another. Informational and advice only, no deadline. */
  readonly coalesceKey?: string;
}

export interface SendResult {
  readonly id: string;
  readonly replayed: boolean;
  readonly coalesced: boolean;
  readonly effectiveClass: DeliveryClass;
  readonly downgraded?: AgentMessageBody["downgraded"];
  /** `ready`: the recipient is available. `queued`: paused or suspended, the message is kept. `unavailable`: stopped, kept. */
  readonly reach: Reach;
  /** A blocking dependency woke the waiting task. */
  readonly woke: boolean;
}

export type AgentMessageView = View<AgentMessageBody> & { readonly trust: "untrusted-content"; readonly reachNow: Reach };

export interface AgentMessageOptions extends RunnerOptions {
  /** What the lifecycle says about a principal now (production: `PauseService.availability`). A throwing hook fails closed: the recipient counts as unavailable. */
  readonly availability: (principalId: string) => Promise<Availability>;
  /** Whether a task is paused (production: `PauseService.isPaused`). Fails closed. */
  readonly taskPaused: (taskId: string) => Promise<boolean>;
  /** Production: `PauseService.guard`. The blocking gates of the task's chain (the task, its assignee agent, the agent's teams, the installation) and the revision checks that lock them; a wake commits together with them. */
  readonly guard: (taskId: string) => Promise<{ readonly blockedBy: readonly unknown[]; readonly changes: readonly Change[] }>;
  readonly waits: WaitService;
  readonly assignments: AssignmentService;
  /** For stand-ups: the meeting whose occurrence opens the batch. */
  readonly meetings?: MeetingService;
  /** For questions to the owner (card H04's inquiries carry them). */
  readonly inquiries?: InquiryService;
  readonly notifications?: NotificationService;
  /**
   * Told when a message has been accepted, for the task's activity record (card C09f): who sent it, to whom, its class and purpose, never its text (the text is an agent's words and stays in the message). Best effort and repeatable
   * (the caller derives a command ID from the message ID); a failure never changes the message.
   */
  readonly onSent?: (event: { readonly messageId: string; readonly taskId: string; readonly sender: string; readonly ownerSent: boolean; readonly to: string; readonly class: string; readonly purpose: string }) => Promise<void>;
  /** Test and tuning hooks: the cap on open deadline requests (default 1000) and the places above it kept for the owner (default 50). */
  readonly deadlineCap?: number;
  readonly ownerDeadlineReserve?: number;
  readonly allowance?: { readonly count: number; readonly windowMinutes: number };
}

export interface OwnerQuestionView {
  /** The question and the wait's words are an agent's: data to show the owner, never instructions to follow. */
  readonly trust: "untrusted-content";
  readonly inquiryId: string;
  readonly asker: string;
  readonly question: string;
  readonly askedAt: string;
  readonly revision: number;
  readonly task: { readonly id: string; readonly title: string; readonly state: string; readonly projectId: string; readonly projectName: string };
  /** The wait the answer will resolve, with its terms. */
  readonly wait?: { readonly id: string; readonly summary: string; readonly nextAction: string; readonly deadline?: string; readonly state: string };
}

/**
 * Agent messages, delivery classes and the interruption budget (card U12). A message is a durable envelope (task, sender, purpose, urgency, optional deadline, correlation ID) in the recipient's
 * inbox, with separate recorded states (accepted, delivered, handled, answered). The class decides when it is read: informational at the next check-in or stand-up, advice at the next safe boundary,
 * a blocking dependency by waking the waiting task, an urgent control request as a bounded interruption. Nothing here resumes, un-pauses or reassigns anything: a paused or suspended recipient's
 * messages are accepted and kept, reported as queued (or unavailable when stopped), and neither a wake nor an interruption is delivered until the lifecycle says the recipient is available again.
 *
 * Limits keep agents from interrupting each other: a sender's rate (overall and to one recipient), a recipient's queue (overall and per sender), a longest reply chain, an interruption allowance per
 * window, focus periods in which advice waits, and coalescing of repeated updates. A request with a deadline names who is told if it is not answered in time (`settleDue`).
 */
export class AgentMessageService {
  readonly #runner: CommandRunner;
  readonly #o: AgentMessageOptions;

  private constructor(runner: CommandRunner, options: AgentMessageOptions) {
    this.#runner = runner;
    this.#o = options;
  }

  static withEpoch(storage: ControllerStorage, epoch: number, options: AgentMessageOptions): AgentMessageService {
    return new AgentMessageService(new CommandRunner(storage, epoch, options), options);
  }

  // ---- sending ---------------------------------------------------------------------------------------------------------------

  /** Sends a message (or a reply). The sender is the authenticated principal; it needs `message.send` on the task (and `message.urgent` for an urgent control request). */
  async send(by: Principal, command: SendAgentMessage): Promise<SendResult> {
    onlyKnown(command, ["commandId", "taskId", "to", "class", "purpose", "text", "expectsReply", "deadline", "escalateTo", "replyTo", "correlationId", "coalesceKey"]);
    const klass = (DELIVERY_CLASSES as readonly string[]).includes(command.class) ? command.class : invalid("class", `must be one of ${DELIVERY_CLASSES.join(", ")}`);
    const purpose = plain(command.purpose, "purpose", MESSAGE_LIMITS.purpose);
    const body = plain(command.text, "text", MESSAGE_LIMITS.text);
    if (command.expectsReply !== undefined && typeof command.expectsReply !== "boolean") invalid("expectsReply", "must be true or false");
    const key = command.coalesceKey === undefined ? undefined : (typeof command.coalesceKey === "string" && KEY.test(command.coalesceKey) ? command.coalesceKey : invalid("coalesceKey", "must be a short code"));
    if (command.correlationId !== undefined && (typeof command.correlationId !== "string" || !CORRELATION.test(command.correlationId))) invalid("correlationId", "must be a short code");
    if (command.replyTo !== undefined && command.correlationId !== undefined) invalid("correlationId", "a reply carries the correlation ID of the message it answers");
    const replyTo = command.replyTo === undefined ? undefined : this.#id(command.replyTo, "replyTo");
    if (replyTo === undefined && (command.taskId === undefined || command.to === undefined)) invalid(command.taskId === undefined ? "taskId" : "to", "is required (only a reply may leave it out)");
    const wantsReply = command.expectsReply === true || command.deadline !== undefined;
    if (command.deadline !== undefined && (typeof command.deadline !== "string" || !TIMESTAMP.test(command.deadline))) invalid("deadline", "must be a UTC timestamp such as 2026-10-20T12:00:00.000Z");
    if ((command.deadline === undefined) !== (command.escalateTo === undefined)) invalid(command.deadline === undefined ? "escalateTo" : "deadline", "a deadline needs escalateTo, who is told if there is no reply in time, and the other way round");
    if (key !== undefined && (command.deadline !== undefined || replyTo !== undefined || (klass !== "informational" && klass !== "advice"))) invalid("coalesceKey", "applies to informational and advice messages that are not replies and have no deadline");
    if (replyTo !== undefined && command.deadline !== undefined) invalid("deadline", "a reply has no deadline");
    const escalateTo = command.escalateTo === undefined ? undefined : this.#principalId(command.escalateTo, "escalateTo");
    const scoped = scopedCommandId(by.id, command.commandId);
    const newId = derivedId("amg", scoped);
    // The wake answer is never cut: a blocking dependency that would not fit in the wait's answer is refused.
    if (klass === "blocking-dependency" && wakeAnswer(newId, purpose, body).length > WAIT_LIMITS.answer) invalid("text", `a blocking dependency's purpose and text together must fit in ${WAIT_LIMITS.answer - 40} characters (they become the answer of the wait)`);
    const payload = { class: klass, purpose, text: body, wantsReply, to: command.to ?? null, taskId: command.taskId ?? null, replyTo: replyTo ?? null, correlationId: command.correlationId ?? null, deadline: command.deadline ?? null, escalateTo: escalateTo ?? null, key: key ?? null } as unknown as JsonObject;
    const result = await this.#retrying(() => this.#runner.command("message.send", { commandId: scoped, actor: by.id }, async () => ({
      payload,
      build: () => this.#plan(by, { newId, scoped, klass, purpose, body, wantsReply, key, replyTo, correlationId: command.correlationId, deadline: command.deadline, escalateTo, taskId: command.taskId, to: command.to }),
    })));
    const stored = (await this.#runner.get("agent-message", result.id))?.body as unknown as AgentMessageBody | undefined;
    if (stored === undefined) throw new DomainError("unavailable", "the message was accepted but cannot be read back");
    if (this.#o.onSent !== undefined) { try { await this.#o.onSent({ messageId: result.id, taskId: stored.taskId, sender: by.id, ownerSent: by.kind === "owner", to: stored.to, class: stored.effectiveClass, purpose: stored.purpose }); } catch { /* the record of a message never changes it */ } }
    const coalesced = result.id !== newId;
    let woke = false;
    if (stored.effectiveClass === "blocking-dependency" && stored.state === "accepted") woke = (await this.#tryWake(result.id)) === "woke";
    else if (stored.effectiveClass === "blocking-dependency") woke = stored.via === "wake";
    return { id: result.id, replayed: result.replayed, coalesced, effectiveClass: stored.effectiveClass, ...(stored.downgraded === undefined ? {} : { downgraded: stored.downgraded }), reach: stored.reach, woke };
  }

  async #plan(by: Principal, c: {
    newId: string; scoped: string; klass: DeliveryClass; purpose: string; body: string; wantsReply: boolean; key: string | undefined; replyTo: string | undefined; correlationId: string | undefined;
    deadline: string | undefined; escalateTo: string | undefined; taskId: string | undefined; to: string | undefined;
  }) {
    const now = this.#runner.now();
    const sender = await this.#fresh(by.id, by.taskScope);
    if (sender === undefined) throw new DomainError("forbidden", `${by.id} may not send messages`);
    // The parent of a reply fixes the task, the recipient and the correlation; only its recipient may answer it, and only once it has been delivered.
    let parent: Aggregate | undefined;
    let parentBody: AgentMessageBody | undefined;
    if (c.replyTo !== undefined) {
      parent = await this.#runner.get("agent-message", c.replyTo);
      parentBody = parent?.body as unknown as AgentMessageBody | undefined;
      if (parent === undefined || parentBody === undefined || parentBody.to !== by.id) throw new DomainError("forbidden", `${by.id} may not reply to that message`);
      if (parentBody.sender === SYSTEM) invalid("replyTo", "an escalation notice is not answered; act on the request it names");
      if (parentBody.state === "accepted") throw new DomainError("invalid_command", "a message can be answered only after it was delivered", { field: "replyTo" });
      if ((c.taskId !== undefined && c.taskId !== parentBody.taskId) || (c.to !== undefined && c.to !== parentBody.sender)) invalid("replyTo", "a reply is about the task of the message it answers and goes to its sender");
    }
    const taskId = checkTaskId(parentBody?.taskId ?? c.taskId);
    const to = parentBody?.sender ?? this.#principalId(c.to, "to");
    const task = await this.#runner.get("task", taskId);
    const projectId = (task?.body as unknown as TaskBody | undefined)?.projectId;
    // A task the sender may not message about reads exactly like one that does not exist.
    if (projectId === undefined || !allows(sender, "message.send", projectId, { resource: { kind: "task", id: taskId }, now }) || (sender.taskScope !== undefined && sender.taskScope.taskId !== taskId)) throw new DomainError("forbidden", `${by.id} may not send messages about that task`);
    if (to === by.id) invalid("to", "cannot be the sender");
    const recipient = await this.#reachable(to, projectId, taskId);
    if (recipient === undefined) throw new DomainError("forbidden", `${by.id} cannot message ${to} about that task`);
    if (c.klass === "urgent-control" && !allows(sender, "message.urgent", projectId, { resource: { kind: "task", id: taskId }, now })) throw new DomainError("forbidden", `${by.id} has no authority to interrupt about that task; a parent or senior role is not enough, it needs the message.urgent grant`);
    if (recipient.kind === "owner" && (c.klass === "urgent-control" || c.klass === "blocking-dependency")) invalid("class", "the owner is not interrupted or woken by agent messages; use informational or advice, or ask the owner a question");
    let escalateTo: string | undefined;
    if (c.escalateTo !== undefined) {
      const target = await this.#reachable(c.escalateTo, projectId, taskId);
      if (target === undefined || c.escalateTo === by.id) throw new DomainError("forbidden", `${c.escalateTo} cannot be named as the escalation path`);
      // Supervisor tier first: a sender with a supervisor names one (the owner is for senders with nobody above them).
      const above = await this.#supervisors(by.id);
      if (above.length > 0 && !above.includes(c.escalateTo)) invalid("escalateTo", `name your supervisor (${above[0]}) or one above it; the owner and others are the path for senders with no supervisor`);
      escalateTo = c.escalateTo;
    }
    if (c.deadline !== undefined && (c.deadline <= now || c.deadline > addMs(now, MESSAGE_LIMITS.deadlineMaxDays * 86_400_000))) invalid("deadline", `must be in the future and within ${MESSAGE_LIMITS.deadlineMaxDays} days`);
    const depth = parentBody === undefined ? 0 : parentBody.depth + 1;
    if (depth > MESSAGE_LIMITS.depth) throw new DomainError("unavailable", `this reply chain is ${MESSAGE_LIMITS.depth} messages long; stop replying and escalate to a person or a manager`);

    // The sender's rate (overall and to this recipient), in a window that restarts when it has passed.
    const rateAgg = await this.#runner.get("agent-rate", by.id);
    const rate = rateAgg?.body as unknown as RateBody | undefined;
    const fresh = rate === undefined || Date.parse(now) - Date.parse(rate.windowStart) >= RATE_WINDOW_MS;
    const used = fresh ? { windowStart: now, count: 0, perRecipient: {} as Record<string, number> } : rate;
    // The owner is not rate limited: the owner's instruction must always get through.
    const isOwner = sender.kind === "owner";
    if (!isOwner && used.count >= MESSAGE_LIMITS.perMinute) throw new DomainError("unavailable", `${by.id} has sent ${MESSAGE_LIMITS.perMinute} messages this minute; wait and batch updates`);
    if (!isOwner && (used.perRecipient[to] ?? 0) >= MESSAGE_LIMITS.perRecipientPerMinute) throw new DomainError("unavailable", `${by.id} has sent ${MESSAGE_LIMITS.perRecipientPerMinute} messages to ${to} this minute; wait and batch updates`);
    const nextRate: RateBody = { windowStart: used.windowStart, count: used.count + 1, perRecipient: { ...used.perRecipient, [to]: (used.perRecipient[to] ?? 0) + 1 } };

    const inboxAgg = await this.#runner.get("agent-inbox", inboxIdOf(to));
    const inbox = inboxAgg === undefined ? this.#emptyInbox(now) : inboxAgg.body as unknown as InboxBody;
    const changes: Change[] = [];

    // Repeated updates: the waiting message with the same sender, task and key takes the new text.
    const target = c.key === undefined ? undefined : inbox.pending.find((p) => p.sender === by.id && p.taskId === taskId && p.key === c.key && p.class === c.klass);
    if (target !== undefined) {
      const old = await this.#runner.get("agent-message", target.id);
      const ob = old?.body as unknown as AgentMessageBody | undefined;
      if (old !== undefined && ob !== undefined && ob.state === "accepted") {
        const merged: AgentMessageBody = { ...ob, text: c.body, purpose: c.purpose, count: ob.count + 1, lastAt: now };
        const ref: AggregateRef = { kind: "agent-message", id: old.id };
        changes.push({ type: "update", ref, expectedRevision: old.revision, body: merged as unknown as JsonObject });
        // The inbox is only checked: the queue is unchanged.
        changes.push(this.#guard("agent-inbox", inboxIdOf(to), inboxAgg));
        if (!isOwner) changes.push(this.#put("agent-rate", by.id, rateAgg, nextRate));
        return { ref, creates: false, changes, detail: { coalesced: true, to, taskId }, contention: async () => new DomainError("stale_revision", "the inbox changed at the same moment") };
      }
    }

    // The class applied.
    let effectiveClass = c.klass;
    let downgraded: AgentMessageBody["downgraded"];
    const allowance = this.#o.allowance ?? { count: MESSAGE_LIMITS.allowance, windowMinutes: MESSAGE_LIMITS.allowanceWindowMinutes };
    // A rolling window: only the interruptions accepted in the last window count, however they fall in the clock.
    let times = inbox.interrupts.times.filter((t) => Date.parse(now) - Date.parse(t) < allowance.windowMinutes * 60_000);
    if (c.klass === "blocking-dependency" && !(await this.#eligibleWait(taskId, by.id, to))) { effectiveClass = "advice"; downgraded = "no_eligible_wait"; }
    if (c.klass === "urgent-control" && !isOwner) {
      if (times.length >= allowance.count) { effectiveClass = "advice"; downgraded = "interruption_allowance"; } else times = [...times, now];
    }

    // Queues: the recipient's, and this sender's share of it. Peers fill 100 places; an authorized interruption (the sender holds message.urgent and the allowance has room) may use 20 more, escalations 20 more after that, and the owner has 20 above all of those that nobody else can use (hard bound 160), so neither a flood nor a slow stream of interruptions can lock the owner out.
    const cap = isOwner ? MESSAGE_LIMITS.queue + MESSAGE_LIMITS.urgentReserve + MESSAGE_LIMITS.escalationReserve + MESSAGE_LIMITS.ownerReserve : MESSAGE_LIMITS.queue + (effectiveClass === "urgent-control" ? MESSAGE_LIMITS.urgentReserve : 0);
    if (inbox.pending.length >= cap) throw new DomainError("unavailable", `${to} already has ${inbox.pending.length} messages waiting; the sender may retry once some are read`);
    if (!isOwner && effectiveClass !== "urgent-control" && inbox.pending.filter((p) => p.sender === by.id).length >= MESSAGE_LIMITS.perSenderQueue) throw new DomainError("unavailable", `${by.id} already has ${MESSAGE_LIMITS.perSenderQueue} messages waiting for ${to}; wait for them to be read or coalesce updates with a key`);
    const interrupts = { times };
    const availability = await this.#availabilityOf(to);
    const reach: Reach = availability === "available" ? "ready" : availability === "stopped" ? "unavailable" : "queued";

    // A request with a deadline is listed so the deadline is found without scanning every message.
    let index: Aggregate | undefined;
    let nextIndex: DeadlineIndex | undefined;
    const answersDeadline = parentBody?.deadline !== undefined && parentBody.state !== "answered";
    if (c.deadline !== undefined || answersDeadline) {
      index = await this.#runner.get("agent-deadlines", "all");
      const open = (index?.body as unknown as DeadlineIndex | undefined)?.open ?? [];
      if (c.deadline !== undefined) {
        if (open.length >= (this.#o.deadlineCap ?? MESSAGE_LIMITS.openDeadlines) + (isOwner ? (this.#o.ownerDeadlineReserve ?? MESSAGE_LIMITS.ownerDeadlineReserve) : 0)) throw new DomainError("unavailable", `there are ${this.#o.deadlineCap ?? MESSAGE_LIMITS.openDeadlines} requests waiting for a reply; none more can be given a deadline now`);
        if (!isOwner && open.filter((o) => o.sender === by.id).length >= MESSAGE_LIMITS.openDeadlinesPerSender) throw new DomainError("unavailable", `${by.id} already has ${MESSAGE_LIMITS.openDeadlinesPerSender} requests with deadlines open`);
        nextIndex = { open: [...open, { id: c.newId, sender: by.id }] };
      } else nextIndex = { open: open.filter((o) => o.id !== c.replyTo) };
    }

    const message: AgentMessageBody = {
      taskId, projectId, sender: by.id, to,
      kind: parentBody !== undefined ? "reply" : c.wantsReply ? "request" : "notice",
      purpose: c.purpose, text: c.body, class: c.klass, effectiveClass, ...(downgraded === undefined ? {} : { downgraded }),
      urgency: URGENCY[effectiveClass], correlationId: parentBody?.correlationId ?? c.correlationId ?? c.newId, ...(c.replyTo === undefined ? {} : { replyTo: c.replyTo }),
      depth, ...(c.deadline === undefined ? {} : { deadline: c.deadline }), ...(escalateTo === undefined ? {} : { escalateTo }),
      state: "accepted", reach, ...(c.key === undefined ? {} : { coalesceKey: c.key }), count: 1, sentAt: now, lastAt: now,
    };
    const ref: AggregateRef = { kind: "agent-message", id: c.newId };
    const entry: PendingEntry = { id: c.newId, class: effectiveClass, sender: by.id, taskId, ...(c.key === undefined ? {} : { key: c.key }), at: now };
    changes.push({ type: "create", ref, body: message as unknown as JsonObject });
    changes.push(this.#put("agent-inbox", inboxIdOf(to), inboxAgg, { ...inbox, pending: [...inbox.pending, entry], interrupts }));
    if (!isOwner) changes.push(this.#put("agent-rate", by.id, rateAgg, nextRate));
    if (nextIndex !== undefined) changes.push(this.#put("agent-deadlines", "all", index, nextIndex));
    if (parent !== undefined && parentBody !== undefined) changes.push({ type: "update", ref: { kind: "agent-message", id: parent.id }, expectedRevision: parent.revision, body: { ...parentBody, state: "answered", answeredAt: now, replyId: c.newId } as unknown as JsonObject });
    return { ref, creates: true, changes, detail: { to, taskId, class: effectiveClass, correlationId: message.correlationId }, contention: async () => new DomainError("stale_revision", "the inbox changed at the same moment") };
  }

  // ---- reading and delivery --------------------------------------------------------------------------------------------------

  /**
   * What the recipient may read now at a boundary, oldest first. Reading changes nothing; `acknowledge` records delivery. A `stand-up` names a meeting occurrence the recipient is on the roster of.
   * `interrupt` returns urgent control requests only while the recipient and the message's task are not paused or suspended, so asking to be interrupted never wakes anything. During a focus period `safe-boundary`
   * returns nothing (the advice waits for the end of the focus period or the next check-in).
   */
  async readable(by: Principal, query: { boundary: MessageBoundary; occurrenceId?: string; limit?: number }): Promise<{ items: AgentMessageView[]; withheld: number; withheldReason?: "focus" | "paused" }> {
    onlyKnown(query, ["boundary", "occurrenceId", "limit"]);
    const boundary = this.#boundary(query.boundary);
    const limit = query.limit ?? MESSAGE_LIMITS.batch;
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > MESSAGE_LIMITS.batch) invalid("limit", `must be a whole number from 1 to ${MESSAGE_LIMITS.batch}`);
    const me = await this.#fresh(by.id, by.taskScope);
    if (me === undefined) return { items: [], withheld: 0 };
    await this.#checkStandUp(me, boundary, query.occurrenceId);
    const now = this.#runner.now();
    const inbox = (await this.#runner.get("agent-inbox", inboxIdOf(by.id)))?.body as unknown as InboxBody | undefined;
    const items: AgentMessageView[] = [];
    let withheld = 0;
    let reason: "focus" | "paused" | undefined;
    if (inbox === undefined) return { items, withheld };
    if (boundary === "safe-boundary" && inbox.focus !== undefined && inbox.focus.until > now) {
      return { items, withheld: inbox.pending.filter((p) => AT[boundary].includes(p.class)).length, withheldReason: "focus" };
    }
    const available = (await this.#availabilityOf(by.id)) === "available";
    for (const p of inbox.pending) {
      if (!AT[boundary].includes(p.class)) continue;
      if (boundary === "interrupt" && (!available || await this.#taskPausedSafe(p.taskId))) { withheld++; reason = "paused"; continue; }
      const found = await this.#runner.get("agent-message", p.id);
      if (found === undefined || !inTaskScope(me, (found.body as unknown as AgentMessageBody).projectId) || (me.taskScope !== undefined && me.taskScope.taskId !== p.taskId)) continue;
      if (items.length < limit) items.push(await this.#asView(found)); else withheld++;
    }
    return { items, withheld, ...(reason === undefined ? {} : { withheldReason: reason }) };
  }

  /**
   * How many messages wait for an agent at the stand-up boundary (informational and advice, the classes a stand-up delivers), for the controller to say so in the agent's stand-up brief. Service principals only. Counts what
   * is queued now; it reads nothing of the messages and delivers none: the agent reads and confirms them at the stand-up itself.
   */
  async waitingAtStandup(by: Principal, agent: string): Promise<number> {
    if ((by.kind !== "owner" && by.kind !== "host" && by.kind !== "service") || by.taskScope !== undefined) throw new DomainError("forbidden", `${by.id} may not count another agent's messages`);
    if (typeof agent !== "string" || !/^agent:[a-z0-9][a-z0-9-]{0,39}$/.test(agent)) invalid("agent", "is not an agent principal");
    const inbox = (await this.#runner.get("agent-inbox", inboxIdOf(agent)))?.body as unknown as InboxBody | undefined;
    return inbox === undefined ? 0 : inbox.pending.filter((p) => AT["stand-up"].includes(p.class)).length;
  }

  /**
   * The recipient confirms receiving messages read at a boundary: they become `delivered` and leave the queue. A message the boundary may not deliver (an informational one at a safe boundary, an urgent one while
   * paused, a blocking dependency) is refused and stays queued. Repeating it is safe: messages already delivered are reported as delivered.
   */
  async acknowledge(by: Principal, command: NoActor & { boundary: MessageBoundary; messageIds: readonly string[]; occurrenceId?: string }): Promise<{ delivered: string[]; refused: { id: string; reason: string }[] }> {
    onlyKnown(command, ["commandId", "boundary", "messageIds", "occurrenceId"]);
    const boundary = this.#boundary(command.boundary);
    if (!Array.isArray(command.messageIds) || command.messageIds.length < 1 || command.messageIds.length > MESSAGE_LIMITS.batch) invalid("messageIds", `must list 1 to ${MESSAGE_LIMITS.batch} message IDs`);
    const ids = [...new Set(command.messageIds.map((id) => this.#id(id, "messageIds")))];
    const me = await this.#fresh(by.id, by.taskScope);
    if (me === undefined) throw new DomainError("forbidden", `${by.id} may not read messages`);
    await this.#checkStandUp(me, boundary, command.occurrenceId);
    let outcome: { delivered: string[]; refused: { id: string; reason: string }[] } = { delivered: [], refused: [] };
    await this.#retrying(() => this.#runner.command("message.acknowledge", { commandId: scopedCommandId(by.id, command.commandId), actor: by.id }, async () => ({
      payload: { boundary, ids: [...ids].sort(), ...(command.occurrenceId === undefined ? {} : { occurrenceId: command.occurrenceId }) },
      build: async () => {
        const now = this.#runner.now();
        const inboxAgg = await this.#runner.get("agent-inbox", inboxIdOf(by.id));
        const inbox = inboxAgg?.body as unknown as InboxBody | undefined;
        if (inboxAgg === undefined || inbox === undefined) throw new DomainError("not_found", "nothing is waiting", { field: "messageIds" });
        const delivered: string[] = []; const refused: { id: string; reason: string }[] = [];
        const changes: Change[] = []; const gone = new Set<string>();
        const focus = inbox.focus !== undefined && inbox.focus.until > now;
        const available = (await this.#availabilityOf(by.id)) === "available";
        for (const id of ids) {
          const found = await this.#runner.get("agent-message", id);
          const m = found?.body as unknown as AgentMessageBody | undefined;
          // Another recipient's message reads like a missing one.
          if (found === undefined || m === undefined || m.to !== by.id || !inTaskScope(me, m.projectId) || (me.taskScope !== undefined && me.taskScope.taskId !== m.taskId)) { refused.push({ id, reason: "not found" }); continue; }
          if (m.state !== "accepted") { delivered.push(id); continue; }
          if (!AT[boundary].includes(m.effectiveClass)) { refused.push({ id, reason: `a ${m.effectiveClass} message is not delivered at a ${boundary}` }); continue; }
          if (boundary === "safe-boundary" && focus) { refused.push({ id, reason: "the recipient is in a focus period" }); continue; }
          if (boundary === "interrupt" && (!available || await this.#taskPausedSafe(m.taskId))) { refused.push({ id, reason: "the recipient or its task is paused or unavailable; the request stays queued" }); continue; }
          changes.push({ type: "update", ref: { kind: "agent-message", id }, expectedRevision: found.revision, body: { ...m, state: "delivered", deliveredAt: now, via: boundary === "interrupt" ? "interrupt" : boundary } as unknown as JsonObject });
          gone.add(id); delivered.push(id);
        }
        outcome = { delivered, refused };
        if (gone.size === 0) throw new DomainError("not_found", "nothing was delivered", { field: "messageIds" });
        changes.push({ type: "update", ref: { kind: "agent-inbox", id: inboxIdOf(by.id) }, expectedRevision: inboxAgg.revision, body: { ...inbox, pending: inbox.pending.filter((p) => !gone.has(p.id)) } as unknown as JsonObject });
        return { ref: { kind: "agent-inbox", id: inboxIdOf(by.id) }, creates: false, changes, detail: { boundary, delivered: gone.size }, contention: async () => new DomainError("stale_revision", "the inbox changed at the same moment") };
      },
    }))).catch((error: unknown) => {
      // Nothing deliverable: report what was refused (or already delivered) without failing.
      if (error instanceof DomainError && error.code === "not_found" && error.field === "messageIds") return undefined;
      throw error;
    });
    if (outcome.delivered.length === 0 && outcome.refused.length === 0) {
      // A repeat of a call that already delivered: report from the records.
      for (const id of ids) {
        const m = (await this.#runner.get("agent-message", id))?.body as unknown as AgentMessageBody | undefined;
        if (m !== undefined && m.to === by.id && m.state !== "accepted") outcome.delivered.push(id); else outcome.refused.push({ id, reason: m === undefined || m.to !== by.id ? "not found" : "still queued" });
      }
    }
    return outcome;
  }

  /** The recipient says it dealt with a delivered message. `handled` is the recipient's word, not a verified fact. */
  async markHandled(by: Principal, command: NoActor & { messageId: string }): Promise<void> {
    onlyKnown(command, ["commandId", "messageId"]);
    const id = this.#id(command.messageId, "messageId");
    await this.#runner.command("message.handled", { commandId: scopedCommandId(by.id, command.commandId), actor: by.id }, async () => ({
      payload: { messageId: id },
      build: async () => {
        const found = await this.#runner.get("agent-message", id);
        const m = found?.body as unknown as AgentMessageBody | undefined;
        if (found === undefined || m === undefined || m.to !== by.id) throw new DomainError("forbidden", `${by.id} may not mark that message`);
        if (m.state === "accepted") throw new DomainError("invalid_command", "a message can be handled only after it was delivered", { field: "messageId" });
        const ref: AggregateRef = { kind: "agent-message", id };
        // Handled is not a step back for an answered message.
        const next: AgentMessageBody = m.state === "delivered" ? { ...m, state: "handled", handledAt: this.#runner.now() } : m;
        return { ref, creates: false, changes: [{ type: "update", ref, expectedRevision: found.revision, body: next as unknown as JsonObject }], detail: { messageId: id } };
      },
    }));
  }

  /** One message as the sender, the recipient or the owner may see it. Anyone else gets `undefined`, as for a message that does not exist. */
  async get(viewer: Principal, messageId: string): Promise<AgentMessageView | undefined> {
    if (typeof messageId !== "string" || !MESSAGE_ID.test(messageId)) return undefined;
    const found = await this.#runner.get("agent-message", messageId);
    const m = found?.body as unknown as AgentMessageBody | undefined;
    if (found === undefined || m === undefined) return undefined;
    if (viewer.kind !== "owner" && viewer.id !== m.sender && viewer.id !== m.to) return undefined;
    if (!inTaskScope(viewer, m.projectId) || (viewer.taskScope !== undefined && viewer.taskScope.taskId !== m.taskId)) return undefined;
    return this.#asView(found);
  }

  /** What is waiting for a recipient, with its focus period and how much of its interruption allowance is used. Only the recipient and the owner see it. */
  async inbox(viewer: Principal, recipient: string): Promise<{ items: AgentMessageView[]; focus?: InboxBody["focus"]; interruptionsUsed: number } | undefined> {
    if (typeof recipient !== "string" || !PRINCIPAL.test(recipient) || (viewer.kind !== "owner" && viewer.id !== recipient)) return undefined;
    const inbox = (await this.#runner.get("agent-inbox", inboxIdOf(recipient)))?.body as unknown as InboxBody | undefined;
    if (inbox === undefined) return { items: [], interruptionsUsed: 0 };
    const items: AgentMessageView[] = [];
    for (const p of inbox.pending) {
      const found = await this.#runner.get("agent-message", p.id);
      if (found !== undefined && inTaskScope(viewer, (found.body as unknown as AgentMessageBody).projectId) && (viewer.taskScope === undefined || viewer.taskScope.taskId === p.taskId)) items.push(await this.#asView(found));
    }
    const now = this.#runner.now();
    const allowance = this.#o.allowance ?? { count: MESSAGE_LIMITS.allowance, windowMinutes: MESSAGE_LIMITS.allowanceWindowMinutes };
    const used = inbox.interrupts.times.filter((t) => Date.parse(now) - Date.parse(t) < allowance.windowMinutes * 60_000).length;
    return { items, ...(inbox.focus === undefined || inbox.focus.until <= now ? {} : { focus: inbox.focus }), interruptionsUsed: used };
  }

  // ---- focus periods ---------------------------------------------------------------------------------------------------------

  /**
   * A focus period: until the given time advice waits (check-ins and stand-ups still deliver, and a blocking wake or an authorised urgent request still goes through). The agent itself, the owner or a holder of
   * `agent.manage` may set it; at most 4 hours ahead. Ending it early is `until: null`.
   */
  async setFocus(by: Principal, command: NoActor & { agent: string; until: string | null; reason?: string }): Promise<void> {
    onlyKnown(command, ["commandId", "agent", "until", "reason"]);
    const agent = this.#principalId(command.agent, "agent");
    const now = this.#runner.now();
    const me = await this.#fresh(by.id, by.taskScope);
    if (me === undefined || agent.startsWith("owner:") || (by.id !== agent && !allows(me, "agent.manage", "*", { now }))) throw new DomainError("forbidden", `${by.id} may not set a focus period for ${agent}`);
    if (me.taskScope !== undefined && by.id !== agent) throw new DomainError("forbidden", `${by.id} may not set a focus period for ${agent}`);
    let until: string | undefined;
    if (command.until !== null) {
      until = typeof command.until === "string" && TIMESTAMP.test(command.until) ? command.until : invalid("until", "must be a UTC timestamp or null");
      if (until <= now || until > addMs(now, MESSAGE_LIMITS.focusMaxMinutes * 60_000)) invalid("until", `must be in the future and within ${MESSAGE_LIMITS.focusMaxMinutes} minutes`);
    }
    const reason = command.reason === undefined ? "focus" : plain(command.reason, "reason", MESSAGE_LIMITS.purpose);
    await this.#retrying(() => this.#runner.command("message.focus", { commandId: scopedCommandId(by.id, command.commandId), actor: by.id }, async () => ({
      payload: { agent, until: until ?? null, reason },
      build: async () => {
        const inboxAgg = await this.#runner.get("agent-inbox", inboxIdOf(agent));
        const inbox = inboxAgg === undefined ? this.#emptyInbox(now) : inboxAgg.body as unknown as InboxBody;
        const { focus: _old, ...rest } = inbox; void _old;
        const next: InboxBody = until === undefined ? rest : { ...rest, focus: { until, setBy: by.id, reason } };
        const ref: AggregateRef = { kind: "agent-inbox", id: inboxIdOf(agent) };
        return { ref, creates: inboxAgg === undefined, changes: [this.#put("agent-inbox", inboxIdOf(agent), inboxAgg, next)], detail: { agent, until: until ?? null }, contention: async () => new DomainError("stale_revision", "the inbox changed at the same moment") };
      },
    })));
  }

  // ---- wakes and deadlines (called by the controller's own loop) -------------------------------------------------------------

  /**
   * Tries again to wake the waiting task for each blocking dependency queued for a recipient: after a resume, or when it became available again. Only the owner, a host or a service may call it. A message that
   * is still held by a pause stays queued; one whose wait is gone is turned into advice.
   */
  async release(by: Principal, command: { recipient: string }): Promise<{ woken: string[]; stillQueued: string[]; downgraded: string[] }> {
    onlyKnown(command, ["recipient"]);
    if (by.kind !== "owner" && by.kind !== "host" && by.kind !== "service") throw new DomainError("forbidden", `${by.id} may not run the release pass`);
    const recipient = this.#principalId(command.recipient, "recipient");
    const inbox = (await this.#runner.get("agent-inbox", inboxIdOf(recipient)))?.body as unknown as InboxBody | undefined;
    const report = { woken: [] as string[], stillQueued: [] as string[], downgraded: [] as string[] };
    for (const p of inbox?.pending ?? []) {
      if (p.class !== "blocking-dependency") continue;
      const r = await this.#tryWake(p.id);
      if (r === "woke") report.woken.push(p.id); else if (r === "queued") report.stillQueued.push(p.id); else if (r === "downgraded") report.downgraded.push(p.id);
    }
    return report;
  }

  /**
   * Sends the escalation for each request whose deadline has passed without a reply: the controller writes an advice message to the path the sender named (nothing is woken, nobody is interrupted). Repeating it
   * does nothing twice. Only the owner, a host or a service may call it. A full queue on the escalation path leaves that request for the next pass (`blocked`).
   */
  async settleDue(by: Principal): Promise<{ escalated: string[]; blocked: string[]; cleared: number }> {
    if (by.kind !== "owner" && by.kind !== "host" && by.kind !== "service") throw new DomainError("forbidden", `${by.id} may not settle deadlines`);
    const out = { escalated: [] as string[], blocked: [] as string[], cleared: 0 };
    const index = (await this.#runner.get("agent-deadlines", "all"))?.body as unknown as DeadlineIndex | undefined;
    for (const open of index?.open ?? []) {
      const now = this.#runner.now();
      const found = await this.#runner.get("agent-message", open.id);
      const m = found?.body as unknown as AgentMessageBody | undefined;
      if (found === undefined || m === undefined || m.deadline === undefined || m.escalateTo === undefined) { await this.#unlist(open.id, by); out.cleared++; continue; }
      if (m.state === "answered") { await this.#unlist(open.id, by); out.cleared++; continue; }
      if (m.deadline > now) continue;
      const result = await this.#retrying(() => this.#escalate(open.id, by));
      if (result === "escalated") out.escalated.push(open.id); else if (result === "blocked") out.blocked.push(open.id); else out.cleared++;
    }
    return out;
  }

  // ---- questions to the owner ------------------------------------------------------------------------------------------------

  /**
   * An agent asks the owner a question about a task it works on (the question is a durable inquiry, H04, addressed to the installation's owner). When the task is blocked in a typed wait (S08) for the owner, `waitId`
   * links the two: the owner's answer resolves the wait. The owner is shown the question with the task's context in `ownerQuestions`, and is told through the owner notifications when those are wired.
   */
  async askOwner(by: Principal, command: NoActor & { taskId: string; question: string; waitId?: string }): Promise<{ inquiryId: string; replayed: boolean }> {
    onlyKnown(command, ["commandId", "taskId", "question", "waitId"]);
    const inquiries = this.#o.inquiries ?? invalid("inquiries", "questions to the owner are not set up");
    const owner = (await this.#runner.get("installation", "installation"))?.body as unknown as { ownerId?: string } | undefined;
    if (owner?.ownerId === undefined) throw new DomainError("unavailable", "this installation has no owner yet");
    // The agent asks about a task it works on: the project-wide right to work is not enough, the task is assigned to it (a task credential is its agent's, cut to one task).
    const assignment = await this.#o.assignments.getAssignment(command.taskId);
    if (by.kind === "agent" && assignment?.owner !== undefined && by.id !== `agent:${assignment.owner.id}`) throw new DomainError("forbidden", `${by.id} may not ask about that task`);
    if (by.kind === "agent" && assignment?.owner === undefined) throw new DomainError("forbidden", `${by.id} may not ask about that task`);
    const asked = await inquiries.ask(by, { commandId: command.commandId, taskId: command.taskId, to: owner.ownerId, question: command.question, ...(command.waitId === undefined ? {} : { waitId: command.waitId }) });
    // Reported to the owner's notifications under a command ID derived from the inquiry, so a repeat of this call does it once.
    // A repeat after the question was already answered finds nothing open to tell the owner about; that is not an error of the repeat.
    if (this.#o.notifications !== undefined) await this.#o.notifications.emitFromController({ commandId: `${asked.id}-note`, kind: "owner-question", ref: { kind: "inquiry", id: asked.id } }).catch((error: unknown) => { if (!(error instanceof DomainError && error.code === "invalid_command")) throw error; });
    return { inquiryId: asked.id, replayed: asked.replayed };
  }

  /** The questions waiting for the owner, each with the task it is about (title, state, project) and the wait its answer will resolve; each page is in the order asked (pages follow the inquiries' IDs). Owner only. */
  async ownerQuestions(owner: Principal, page: { afterId?: string; limit?: number } = {}): Promise<{ items: OwnerQuestionView[]; next?: string }> {
    if (owner.kind !== "owner") throw new DomainError("forbidden", `${owner.id} is not the owner`);
    const inquiries = this.#o.inquiries ?? invalid("inquiries", "questions to the owner are not set up");
    const pending = await inquiries.pendingFor(owner, page);
    const items: OwnerQuestionView[] = [];
    for (const q of pending.items as View<InquiryBody>[]) {
      const task = (await this.#runner.get("task", q.taskId))?.body as unknown as TaskBody | undefined;
      const project = (await this.#runner.get("project", q.projectId))?.body as unknown as { name?: string } | undefined;
      const wait = q.waitId === undefined ? undefined : await this.#o.waits.getWait(q.waitId);
      items.push({
        trust: "untrusted-content", inquiryId: q.id, asker: q.asker, question: q.question, askedAt: q.askedAt, revision: q.revision,
        task: { id: q.taskId, title: task?.title ?? "", state: task?.state ?? "unknown", projectId: q.projectId, projectName: project?.name ?? "" },
        ...(wait === undefined ? {} : { wait: { id: wait.id, summary: wait.summary, nextAction: wait.nextAction, ...(wait.deadline === undefined ? {} : { deadline: wait.deadline }), state: wait.state } }),
      });
    }
    items.sort((a, b) => a.askedAt.localeCompare(b.askedAt) || a.inquiryId.localeCompare(b.inquiryId));
    return { items, ...(pending.next === undefined ? {} : { next: pending.next }) };
  }

  /** The owner answers: the inquiry is answered and, if the task waits on it, the wait is resolved and the task is ready again. Repeating the call finishes whatever step is missing. */
  async answerOwner(owner: Principal, command: NoActor & { inquiryId: string; answer: string }): Promise<{ id: string; replayed: boolean }> {
    if (owner.kind !== "owner") throw new DomainError("forbidden", `${owner.id} is not the owner`);
    const inquiries = this.#o.inquiries ?? invalid("inquiries", "questions to the owner are not set up");
    const answered = await inquiries.answer(owner, command);
    // The owner-question notification is closed with the answer (a repeat finds it closed already).
    if (this.#o.notifications !== undefined) {
      const items = (await this.#o.notifications.inbox(owner)).items;
      const item = items.find((i) => i.kind === "owner-question" && i.ref.kind === "inquiry" && i.ref.id === answered.id);
      if (item !== undefined) await this.#o.notifications.answerItem(owner, { commandId: `${answered.id}-note-ok`, itemId: item.id, answer: "ok", revision: item.revision });
    }
    return answered;
  }

  /**
   * Where a question stands for its addressee: `queued` when the addressee is paused or suspended, `unavailable` when stopped, `ready` otherwise. Asking never wakes, resumes or reassigns anything; the question waits
   * in the addressee's list of pending inquiries until it can be answered. Visible to the asker, the addressee and the owner.
   */
  async inquiryReach(viewer: Principal, inquiryId: string): Promise<{ state: InquiryBody["state"]; reach: Reach } | undefined> {
    const inquiries = this.#o.inquiries ?? invalid("inquiries", "questions are not set up");
    const shown = await inquiries.view(viewer, inquiryId);
    if (shown === undefined) return undefined;
    const availability = await this.#availabilityOf(shown.inquiry.to);
    return { state: shown.inquiry.state, reach: availability === "available" ? "ready" : availability === "stopped" ? "unavailable" : "queued" };
  }

  // ---- internals -------------------------------------------------------------------------------------------------------------

  async #tryWake(messageId: string): Promise<"woke" | "queued" | "downgraded" | "done"> {
    // A pause landing between the checks and the commit makes the commit fail (the gates commit with the answer); the checks are then made again.
    for (let attempt = 1; attempt <= 5; attempt++) {
      const found = await this.#runner.get("agent-message", messageId);
      const m = found?.body as unknown as AgentMessageBody | undefined;
      if (found === undefined || m === undefined || m.state !== "accepted" || m.effectiveClass !== "blocking-dependency") return "done";
      // A pause (the agent's, its team's, the installation's or the task's), a suspension or a stop holds the wake: the message stays queued and the wait stays open.
      if ((await this.#availabilityOf(m.to)) !== "available" || await this.#taskPausedSafe(m.taskId)) return "queued";
      const sender = await this.#fresh(m.sender);
      if (sender === undefined || !allows(sender, "message.send", m.projectId, { resource: { kind: "task", id: m.taskId }, now: this.#runner.now() })) { await this.#downgrade(messageId, "sender_authority_lost"); return "downgraded"; }
      const answer = wakeAnswer(messageId, m.purpose, m.text);
      const wait = await this.#eligibleWait(m.taskId, m.sender, m.to);
      if (wait === undefined) {
        // A wake that died after the wait was answered (by this very message: the answer names its ID) is finished, not turned into advice.
        const last = await this.#o.waits.lastFor(m.taskId);
        if (last !== undefined && last.state === "answered" && last.reason === "dependency" && last.answeredBy === m.sender && last.answer === answer) {
          await this.#retrying(() => this.#runner.command("message.wake", { commandId: scopedCommandId(m.sender, `${messageId}-woke`), actor: m.sender }, async () => ({ payload: { messageId }, build: async () => this.#settleDelivery(messageId, "wake") })));
          return "woke";
        }
        await this.#downgrade(messageId, "no_eligible_wait"); return "downgraded";
      }
      try {
        await this.#o.waits.answerWait(
          { commandId: scopedCommandId(m.sender, `${messageId}-wake`), actor: m.sender, waitId: wait.id, expectedRevision: wait.revision, resolverId: m.sender, answer },
          { beforeCommit: async () => {
            let g: Awaited<ReturnType<AgentMessageOptions["guard"]>>;
            try { g = await this.#o.guard(m.taskId); } catch { throw new DomainError("unavailable", "the pause state of the task cannot be read"); }
            if (g.blockedBy.length > 0) throw new DomainError("unavailable", "the task or its agent is paused");
            return g.changes;
          } },
        );
      } catch (error) {
        if (!(error instanceof DomainError)) throw error;
        if (error.code === "unavailable") return "queued";
        if (error.code === "stale_revision") continue;
        // The wait closed or changed since it was read: look again; the message is advice if no wait is left.
        if (error.code === "wait_closed" || error.code === "invalid_command") {
          if ((await this.#eligibleWait(m.taskId, m.sender, m.to)) === undefined) { await this.#downgrade(messageId, "no_eligible_wait"); return "downgraded"; }
          return "queued";
        }
        throw error;
      }
      await this.#retrying(() => this.#runner.command("message.wake", { commandId: scopedCommandId(m.sender, `${messageId}-woke`), actor: m.sender }, async () => ({
        payload: { messageId },
        build: async () => this.#settleDelivery(messageId, "wake"),
      })));
      return "woke";
    }
    return "queued";
  }

  /** Records a delivery outside a boundary (a wake): the message and the recipient's queue change together. */
  async #settleDelivery(messageId: string, via: "wake") {
    const found = await this.#runner.get("agent-message", messageId);
    const m = found?.body as unknown as AgentMessageBody;
    const inboxAgg = await this.#runner.get("agent-inbox", inboxIdOf(m.to));
    const inbox = inboxAgg?.body as unknown as InboxBody;
    const ref: AggregateRef = { kind: "agent-message", id: messageId };
    const changes: Change[] = [{ type: "update", ref, expectedRevision: found!.revision, body: { ...m, state: "delivered", deliveredAt: this.#runner.now(), via } as unknown as JsonObject }];
    changes.push({ type: "update", ref: { kind: "agent-inbox", id: inboxIdOf(m.to) }, expectedRevision: inboxAgg!.revision, body: { ...inbox, pending: inbox.pending.filter((p) => p.id !== messageId) } as unknown as JsonObject });
    return { ref, creates: false, changes, detail: { via }, contention: async () => new DomainError("stale_revision", "the inbox changed at the same moment") };
  }

  async #downgrade(messageId: string, reason: NonNullable<AgentMessageBody["downgraded"]>): Promise<void> {
    await this.#retrying(() => this.#runner.command("message.downgrade", { commandId: `${messageId}-down`, actor: SYSTEM }, async () => ({
      payload: { messageId, reason },
      build: async () => {
        const found = await this.#runner.get("agent-message", messageId);
        const m = found?.body as unknown as AgentMessageBody | undefined;
        if (found === undefined || m === undefined || m.state !== "accepted" || m.effectiveClass !== "blocking-dependency") throw new DomainError("invalid_command", "nothing to downgrade");
        const inboxAgg = await this.#runner.get("agent-inbox", inboxIdOf(m.to));
        const inbox = inboxAgg?.body as unknown as InboxBody;
        const ref: AggregateRef = { kind: "agent-message", id: messageId };
        return {
          ref, creates: false,
          changes: [
            { type: "update", ref, expectedRevision: found.revision, body: { ...m, effectiveClass: "advice", urgency: URGENCY.advice, downgraded: reason } as unknown as JsonObject },
            { type: "update", ref: { kind: "agent-inbox", id: inboxIdOf(m.to) }, expectedRevision: inboxAgg!.revision, body: { ...inbox, pending: inbox.pending.map((p) => (p.id === messageId ? { ...p, class: "advice" as const } : p)) } as unknown as JsonObject },
          ],
          detail: { reason }, contention: async () => new DomainError("stale_revision", "the inbox changed at the same moment"),
        };
      },
    }))).catch((error: unknown) => { if (!(error instanceof DomainError && error.code === "invalid_command")) throw error; });
  }

  /** The wait this sender may answer by waking this task: open, a dependency, naming the sender as its resolver, on a task assigned to the recipient. */
  async #eligibleWait(taskId: string, senderId: string, recipientId: string) {
    const wait = await this.#o.waits.openFor(taskId);
    if (wait === undefined || wait.state !== "open" || wait.reason !== "dependency" || wait.resolver !== senderId) return undefined;
    const assignment = await this.#o.assignments.getAssignment(taskId);
    if (assignment === undefined || assignment.state !== "assigned" || assignment.owner === undefined || `${assignment.owner.kind}:${assignment.owner.id}` !== recipientId) return undefined;
    return wait;
  }

  async #escalate(id: string, by: Principal): Promise<"escalated" | "blocked" | "cleared"> {
    const found = await this.#runner.get("agent-message", id);
    const m = found?.body as unknown as AgentMessageBody | undefined;
    if (found === undefined || m === undefined || m.escalateTo === undefined || m.deadline === undefined) return "cleared";
    const escalationId = derivedId("amg", `${id}\0escalation`);
    let result: "escalated" | "blocked" | "cleared" = "escalated";
    await this.#runner.command("message.escalate", { commandId: `${id}-esc`, actor: by.id }, async () => ({
      payload: { messageId: id },
      build: async () => {
        const now = this.#runner.now();
        const parentAgg = await this.#runner.get("agent-message", id);
        const parent = parentAgg?.body as unknown as AgentMessageBody;
        const indexAgg = await this.#runner.get("agent-deadlines", "all");
        const index = indexAgg?.body as unknown as DeadlineIndex;
        const unlisted: Change = this.#put("agent-deadlines", "all", indexAgg, { open: index.open.filter((o) => o.id !== id) });
        const ref: AggregateRef = { kind: "agent-message", id };
        if (parent.state === "answered" || parent.escalatedAt !== undefined || parent.deadline === undefined || parent.deadline > now) { result = "cleared"; return { ref, creates: false, changes: [unlisted, { type: "check", ref, expectedRevision: parentAgg!.revision }], detail: { cleared: true } }; }
        // The path named at send time may since have been disabled or lost its access to the task: the owner is the backstop, so the escalation is never lost.
        let to = parent.escalateTo!;
        let fellBack = false;
        if ((await this.#reachable(to, parent.projectId, parent.taskId)) === undefined) {
          const ownerId = ((await this.#runner.get("installation", "installation"))?.body as unknown as { ownerId?: string } | undefined)?.ownerId;
          if (ownerId === undefined) { result = "blocked"; throw new DomainError("unavailable", "the escalation path is gone and there is no owner"); }
          to = ownerId; fellBack = true;
        }
        const availability = await this.#availabilityOf(to);
        const inboxAgg = await this.#runner.get("agent-inbox", inboxIdOf(to));
        const inbox = inboxAgg === undefined ? this.#emptyInbox(now) : inboxAgg.body as unknown as InboxBody;
        if (inbox.pending.length >= MESSAGE_LIMITS.queue + MESSAGE_LIMITS.urgentReserve + MESSAGE_LIMITS.escalationReserve) { result = "blocked"; throw new DomainError("unavailable", "the escalation path is full"); }
        const escalation: AgentMessageBody = {
          taskId: parent.taskId, projectId: parent.projectId, sender: SYSTEM, to, kind: "escalation",
          purpose: `no reply to ${id} by ${parent.deadline}`.slice(0, MESSAGE_LIMITS.purpose),
          text: `${parent.sender} asked ${parent.to} (${parent.purpose}) and has had no reply by ${parent.deadline}. Original request ${id}, correlation ${parent.correlationId}.${fellBack ? ` It was addressed to ${parent.escalateTo}, who can no longer take it.` : ""}`.slice(0, MESSAGE_LIMITS.text),
          class: "advice", effectiveClass: "advice", urgency: URGENCY.advice, correlationId: parent.correlationId, replyTo: id, depth: parent.depth + 1,
          state: "accepted", reach: availability === "available" ? "ready" : availability === "stopped" ? "unavailable" : "queued", count: 1, sentAt: now, lastAt: now,
        };
        const entry: PendingEntry = { id: escalationId, class: "advice", sender: SYSTEM, taskId: parent.taskId, at: now };
        const escalationRef: AggregateRef = { kind: "agent-message", id: escalationId };
        result = "escalated";
        return {
          ref, creates: false,
          changes: [
            { type: "update", ref, expectedRevision: parentAgg!.revision, body: { ...parent, escalatedAt: now, escalationId } as unknown as JsonObject },
            { type: "create", ref: escalationRef, body: escalation as unknown as JsonObject },
            this.#put("agent-inbox", inboxIdOf(to), inboxAgg, { ...inbox, pending: [...inbox.pending, entry] }),
            unlisted,
          ],
          detail: { escalationId, to }, contention: async () => new DomainError("stale_revision", "the inbox changed at the same moment"),
        };
      },
    })).catch((error: unknown) => { if (result === "blocked" && error instanceof DomainError && error.code === "unavailable") return undefined; throw error; });
    return result;
  }

  /**
   * A notice from the controller itself (card R05e): it tells `to` something about a task, filed as advice in the recipient's inbox with the controller as the sender, as an escalation is. It needs no sender principal and no right,
   * so no agent or conversation can use it and the dispatcher's service principal is not widened; it is called only by code that builds the services. It never wakes anyone: the recipient reads it at a boundary, and a
   * paused or suspended recipient keeps it queued (a stopped one, with reach `unavailable`). Only agents are told. A recipient must be able to read the task, unless the caller names `admit: "budget.manage"` and the recipient holds that right on it. The same `commandId` files it once. A full inbox is `unavailable` (the caller retries later); a recipient who can no longer see the task is `forbidden`.
   */
  async noticeFromController(command: { commandId: string; taskId: string; to: string; purpose: string; text: string; /** A right that admits a recipient who cannot read the task (the budget holder who may decide). */ admit?: "budget.manage" }): Promise<{ id: string; replayed: boolean }> {
    onlyKnown(command, ["commandId", "taskId", "to", "purpose", "text", "admit"]);
    if (command.admit !== undefined && command.admit !== "budget.manage") invalid("admit", "must be budget.manage when given");
    const purpose = plain(command.purpose, "purpose", MESSAGE_LIMITS.purpose);
    const text = plain(command.text, "text", MESSAGE_LIMITS.text);
    const taskId = checkTaskId(command.taskId);
    const to = this.#principalId(command.to, "to");
    const scoped = scopedCommandId(SYSTEM, command.commandId);
    const id = derivedId("amg", scoped);
    return this.#retrying(() => this.#runner.command("message.notice", { commandId: scoped, actor: SYSTEM }, async () => ({
      payload: { taskId, to, purpose, text } as unknown as JsonObject,
      build: async () => {
        const now = this.#runner.now();
        const projectId = ((await this.#runner.get("task", taskId))?.body as unknown as TaskBody | undefined)?.projectId;
        const holder = projectId === undefined ? undefined : await this.#fresh(to);
        // With `admit: "budget.manage"`, a holder who may decide a request is told even when it holds no right to read the task.
        if (projectId === undefined || holder === undefined || holder.kind !== "agent" || ((await this.#reachable(to, projectId, taskId)) === undefined && !(command.admit === "budget.manage" && allows(holder, "budget.manage", projectId, { resource: { kind: "task", id: taskId }, now })))) throw new DomainError("forbidden", `${to} cannot be told about that task`);
        const inboxAgg = await this.#runner.get("agent-inbox", inboxIdOf(to));
        const inbox = inboxAgg === undefined ? this.#emptyInbox(now) : inboxAgg.body as unknown as InboxBody;
        if (inbox.pending.length >= MESSAGE_LIMITS.queue) throw new DomainError("unavailable", `${to} already has ${inbox.pending.length} messages waiting; the notice is retried once some are read`);
        if (inbox.pending.filter((p) => p.sender === SYSTEM).length >= MESSAGE_LIMITS.perSenderQueue) throw new DomainError("unavailable", `${to} already has ${MESSAGE_LIMITS.perSenderQueue} notices from the controller waiting, so others cannot crowd out its other messages; the notice is retried once some are read`);
        const availability = await this.#availabilityOf(to);
        const message: AgentMessageBody = {
          taskId, projectId, sender: SYSTEM, to, kind: "notice", purpose, text, class: "advice", effectiveClass: "advice", urgency: URGENCY.advice, correlationId: id, depth: 0,
          state: "accepted", reach: availability === "available" ? "ready" : availability === "stopped" ? "unavailable" : "queued", count: 1, sentAt: now, lastAt: now,
        };
        const ref: AggregateRef = { kind: "agent-message", id };
        const entry: PendingEntry = { id, class: "advice", sender: SYSTEM, taskId, at: now };
        return {
          ref, creates: true,
          changes: [{ type: "create", ref, body: message as unknown as JsonObject }, this.#put("agent-inbox", inboxIdOf(to), inboxAgg, { ...inbox, pending: [...inbox.pending, entry] })],
          detail: { to, taskId }, contention: async () => new DomainError("stale_revision", "the inbox changed at the same moment"),
        };
      },
    }))).then((result) => ({ id, replayed: result.replayed }));
  }

  async #unlist(id: string, by: Principal): Promise<void> {
    await this.#retrying(() => this.#runner.command("message.unlist", { commandId: `${id}-unlist`, actor: by.id }, async () => ({
      payload: { messageId: id },
      build: async () => {
        const indexAgg = await this.#runner.get("agent-deadlines", "all");
        const index = indexAgg?.body as unknown as DeadlineIndex | undefined;
        if (indexAgg === undefined || index === undefined) throw new DomainError("not_found", "no index");
        return { ref: { kind: "agent-deadlines", id: "all" }, creates: false, changes: [this.#put("agent-deadlines", "all", indexAgg, { open: index.open.filter((o) => o.id !== id) })], detail: { messageId: id }, contention: async () => new DomainError("stale_revision", "the index changed at the same moment") };
      },
    })));
  }

  async #checkStandUp(me: Principal, boundary: MessageBoundary, occurrenceId: string | undefined): Promise<void> {
    if (boundary !== "stand-up") { if (occurrenceId !== undefined) invalid("occurrenceId", "applies to a stand-up only"); return; }
    if (typeof occurrenceId !== "string" || !OCCURRENCE.test(occurrenceId)) invalid("occurrenceId", "a stand-up names the meeting occurrence it is for");
    const meetings = this.#o.meetings ?? invalid("occurrenceId", "stand-ups are not set up");
    const shown = await meetings.occurrence(me, occurrenceId as string);
    const o = shown?.occurrence;
    // The recipient must be on the roster of a live meeting that is under way or still to come; being on the roster is enough to read, being withheld is not (the meeting service decided that).
    if (o === undefined || o.mode !== "live" || (o.state !== "planned" && o.state !== "held") || !o.participants.some((p) => p.id === me.id && (p.status === "eligible" || p.status === "owner-invited"))) {
      throw new DomainError("forbidden", `${me.id} is not a participant of that stand-up`);
    }
  }

  /** The principal IDs of the agent's supervisors, nearest first (bounded, cycle-safe). */
  async #supervisors(principalId: string): Promise<string[]> {
    const out: string[] = [];
    if (!principalId.startsWith("agent:")) return out;
    let id: string | undefined = principalId.slice("agent:".length);
    for (let i = 0; i < 64 && id !== undefined; i++) {
      const next: string | undefined = ((await this.#runner.get("agent", id))?.body as unknown as { supervisorId?: string } | undefined)?.supervisorId;
      if (next === undefined || out.includes(`agent:${next}`)) break;
      out.push(`agent:${next}`);
      id = next;
    }
    return out;
  }

  async #reachable(principalId: string, projectId: string, taskId: string): Promise<Principal | undefined> {
    const p = await this.#fresh(principalId);
    if (p === undefined) return undefined;
    if (p.kind === "owner") return p;
    if (p.kind !== "agent") return undefined;
    const now = this.#runner.now();
    return allows(p, "task.read", projectId, { resource: { kind: "task", id: taskId }, now }) || allows(p, "attempt.work", projectId, { resource: { kind: "task", id: taskId }, now }) ? p : undefined;
  }

  async #fresh(principalId: string, scope?: Principal["taskScope"]): Promise<Principal | undefined> {
    const found = await this.#runner.get("principal", principalId);
    const body = found?.body as unknown as PrincipalBody | undefined;
    if (found === undefined || body === undefined || body.state !== "active") return undefined;
    return effectiveOf(this.#runner, { id: found.id, kind: body.kind, name: body.name, grants: body.grants, ...(scope === undefined ? {} : { taskScope: scope }) }, this.#runner.now());
  }

  /** The lifecycle hook, failing closed: a hook that throws makes the recipient unavailable (the message is kept, nothing is delivered through a gate). */
  async #availabilityOf(principalId: string): Promise<Availability> {
    try { return await this.#o.availability(principalId); } catch { return "suspended"; }
  }

  async #taskPausedSafe(taskId: string): Promise<boolean> {
    try { return await this.#o.taskPaused(taskId); } catch { return true; }
  }

  async #asView(found: Aggregate): Promise<AgentMessageView> {
    const m = view<AgentMessageBody>(found);
    const availability = await this.#availabilityOf(m.to);
    return { ...m, trust: "untrusted-content", reachNow: availability === "available" ? "ready" : availability === "stopped" ? "unavailable" : "queued" };
  }

  #emptyInbox(now: string): InboxBody { return { pending: [], interrupts: { times: [] } }; }

  /** Creates the record, or updates it under the revision just read. */
  #put(kind: string, id: string, existing: Aggregate | undefined, body: object): Change {
    const ref: AggregateRef = { kind, id };
    return existing === undefined ? { type: "create", ref, body: body as unknown as JsonObject } : { type: "update", ref, expectedRevision: existing.revision, body: body as unknown as JsonObject };
  }

  /** A record that must not change while this command commits, though this command does not write it (a missing one cannot be checked, so it is created empty, which fails if someone created it first). */
  #guard(kind: string, id: string, existing: Aggregate | undefined): Change {
    return existing === undefined ? { type: "create", ref: { kind, id }, body: { pending: [], interrupts: { times: [] } } as unknown as JsonObject } : { type: "check", ref: { kind, id }, expectedRevision: existing.revision };
  }

  #id(value: unknown, field: string): string { return typeof value === "string" && MESSAGE_ID.test(value) ? value : invalid(field, "is not a message ID"); }
  #principalId(value: unknown, field: string): string { return typeof value === "string" && PRINCIPAL.test(value) ? value : invalid(field, "is not an agent or owner principal ID"); }
  #boundary(value: unknown): MessageBoundary { return (BOUNDARIES as readonly unknown[]).includes(value) ? value as MessageBoundary : invalid("boundary", `must be one of ${BOUNDARIES.join(", ")}`); }

  /** Two decisions about one inbox or one sender's rate at once meet a revision check; the loser reads again and decides again. Only that race is retried (no waiting: each round has a winner). */
  async #retrying<T>(run: () => Promise<T>): Promise<T> {
    for (let attempt = 1; ; attempt++) {
      try { return await run(); } catch (error) {
        if (!(error instanceof DomainError) || error.code !== "stale_revision" || error.currentRevision !== undefined || attempt >= 64) throw error;
        await new Promise<void>((resolve) => setImmediate(resolve));
      }
    }
  }
}
