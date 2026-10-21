import { DomainError } from "../domain/errors.js";
import { derivedId } from "../domain/ids.js";
import { onlyKnown, projectId as checkProjectId, revision as checkRevision, text, type View } from "../domain/model.js";
import { CommandRunner, view, type RunnerOptions } from "../domain/runner.js";
import { allows } from "../security/access.js";
import { scopedCommandId } from "../security/credentials.js";
import { effectiveOf } from "../security/grants.js";
import type { NoActor, Principal, PrincipalBody } from "../security/principals.js";
import { redactText } from "../security/redact.js";
import type { Aggregate, AggregateRef, Change, ControllerStorage, JsonObject } from "../storage/types.js";

export type MessageKind = "message" | "question" | "answer" | "action-request" | "notice";
export type Priority = "routine" | "urgent";
/** Sending, accepting, delivering, handling and answering are different things (agent-apis): `accepted` is stored for the recipient; `delivered` when the recipient confirmed it received it; `handled` when it dealt with it; `answered` when a reply to it was sent. */
export type MessageDeliveryState = "accepted" | "delivered" | "handled" | "answered";
/** What the lifecycle says about a principal (cards L01 and L02 supply it). A message to one that is not available is accepted and kept; nothing here lifts a hold. */
export type Availability = "available" | "paused" | "suspended" | "stopped";

/** Provisional limits, adjustable (decision record, 2026-10-20). */
export const CONVERSATION_LIMITS = { subject: 200, text: 8000, recipients: 20, participants: 50, queue: 100, perMinute: 30, depth: 20, turnsWithoutOwner: 40, page: 100, ackBatch: 100, claimed: 120, scan: 5000 } as const;

const THREAD_ID = /^thr-[a-z2-7]{20}$/;
const MESSAGE_ID = /^thr-[a-z2-7]{20}\.\d{8}$/;
const PRINCIPAL = /^(?:owner|agent|client):[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const KINDS: readonly string[] = ["message", "question", "answer", "action-request", "notice"];
/** An external client speaks as itself: it may not publish notices. */
const CLIENT_KINDS: readonly string[] = ["message", "question", "answer", "action-request"];
const RATE_WINDOW_MS = 60_000;
const invalid = (field: string, message: string): never => { throw new DomainError("invalid_command", `${field}: ${message}`, { field }); };
const messageIdOf = (threadId: string, seq: number): string => `${threadId}.${String(seq).padStart(8, "0")}`;

export interface ThreadBody {
  readonly projectId: string;
  readonly subject: string;
  readonly participants: readonly string[];
  readonly startedBy: string;
  readonly state: "open" | "closed";
  /** The sequence number the next message takes; sends to a thread are ordered by this record's revision. */
  readonly nextSeq: number;
  /** Messages since the owner last spoke in the thread (the loop guard). */
  readonly turnsWithoutOwner: number;
  readonly createdAt: string;
  readonly closedAt?: string;
  readonly closedBy?: string;
}

export interface MessageBody {
  readonly threadId: string;
  readonly seq: number;
  /** The authenticated principal that sent it. Nothing in the content can change this. */
  readonly sender: string;
  readonly senderKind: string;
  /** What an external client says it speaks for, recorded apart from `sender`; it grants nothing. */
  readonly claimedSender?: string;
  readonly to: readonly string[];
  readonly kind: MessageKind;
  readonly priority: Priority;
  readonly replyTo?: string;
  /** How long the chain of replies this message ends is (a message that replies to nothing has depth 0). */
  readonly depth: number;
  readonly text: string;
  /** True when something in the text looked like a credential and was replaced. */
  readonly redacted: boolean;
  readonly sentAt: string;
  /** An action request is a request, not a command: it enters the normal authorization and task workflow and nothing here carries it out. */
  readonly needsAuthorization: boolean;
}

export interface DeliveryBody {
  readonly messageId: string;
  readonly threadId: string;
  readonly seq: number;
  readonly recipient: string;
  readonly state: MessageDeliveryState;
  /** `queued` when the recipient was not available when the message was accepted. */
  readonly availability: "ready" | "queued";
  readonly acceptedAt: string;
  readonly deliveredAt?: string;
  readonly handledAt?: string;
  readonly answeredAt?: string;
  readonly answeredBy?: string;
}

interface CursorBody { readonly threadId: string; readonly principal: string; readonly deliveredSeq: number }
interface InboxBody { readonly undelivered: number; readonly threads: Readonly<Record<string, number>> }
interface RateBody { readonly windowStart: string; readonly count: number }

/** A message as a reader sees it. The text is always untrusted content. */
export type MessageView = View<MessageBody> & { readonly trust: "untrusted-content"; readonly delivery?: MessageDeliveryState; readonly availability?: "ready" | "queued" };

export interface ConversationOptions extends RunnerOptions {
  /** What the lifecycle says about a principal now. Default: everyone is available. */
  readonly availability?: (principalId: string) => Promise<Availability>;
}

export interface StartThread extends NoActor {
  readonly projectId: string;
  readonly subject: string;
  readonly to: readonly string[];
  readonly kind?: MessageKind;
  readonly text: string;
  readonly priority?: Priority;
  readonly claimedSender?: string;
}
export interface SendMessage extends NoActor {
  readonly threadId: string;
  readonly to?: readonly string[];
  readonly kind?: MessageKind;
  readonly text: string;
  readonly replyTo?: string;
  readonly priority?: Priority;
  readonly claimedSender?: string;
}

/**
 * The durable two-way conversation service (card U02, domain part). Threads, messages, deliveries and cursors are records in the controller's store, so they survive restarts and
 * disconnects and no connection owns them. Either an agent or an external client can start a thread, address participants it may discover, send, and answer. The sender is the
 * authenticated principal; an external client's claim about who it speaks for is kept beside it and gives nothing. A message is untrusted content: it cannot read another desk, cannot
 * give the recipient a capability, and an action request is only a request. A client holds only `conversation.*` actions, so joining a thread adds no tool, task or file capability.
 *
 * Retries are safe: a message is named by its thread and sequence number, and the same command ID returns the same message. Limits keep conversations from interrupting each other: a
 * message size, a recipient queue, a sender's rate, a longest reply chain and a longest run of turns without the owner. A recipient that is paused, suspended or stopped still has its
 * messages accepted and kept, reported as queued; sending is refused to a principal that is not available; nothing here resumes anything.
 */
export class ConversationService {
  readonly #runner: CommandRunner;
  readonly #availability: (principalId: string) => Promise<Availability>;

  private constructor(runner: CommandRunner, options: ConversationOptions) {
    this.#runner = runner;
    this.#availability = options.availability ?? (async () => "available");
  }

  static withEpoch(storage: ControllerStorage, epoch: number, options: ConversationOptions = {}): ConversationService {
    return new ConversationService(new CommandRunner(storage, epoch, options), options);
  }

  /** Starts a thread in a project with a first message. Needs `conversation.start` in the project; every addressee must be reachable by the sender. */
  async start(by: Principal, command: StartThread): Promise<{ threadId: string; messageId: string; replayed: boolean }> {
    onlyKnown(command, ["commandId", "projectId", "subject", "to", "kind", "text", "priority", "claimedSender"]);
    const projectId = checkProjectId(command.projectId);
    const subject = text(command.subject, "subject", { min: 1, max: CONVERSATION_LIMITS.subject });
    const scoped = scopedCommandId(by.id, command.commandId);
    const threadId = derivedId("thr", scoped);
    const r = await this.#retrying(() => this.#append(by, { commandId: command.commandId, scoped, threadId, newThread: { projectId, subject }, to: command.to, kind: command.kind, text: command.text, priority: command.priority, claimedSender: command.claimedSender }));
    return { threadId, messageId: r.id, replayed: r.replayed };
  }

  /** Sends a message in a thread the sender takes part in. Needs `conversation.send` in the thread's project (and `conversation.request-action` for an action request, `conversation.urgent` for an urgent one). */
  async send(by: Principal, command: SendMessage): Promise<{ messageId: string; replayed: boolean }> {
    onlyKnown(command, ["commandId", "threadId", "to", "kind", "text", "replyTo", "priority", "claimedSender"]);
    const threadId = this.#threadId(command.threadId);
    const scoped = scopedCommandId(by.id, command.commandId);
    const r = await this.#retrying(() => this.#append(by, { commandId: command.commandId, scoped, threadId, to: command.to, kind: command.kind, text: command.text, replyTo: command.replyTo, priority: command.priority, claimedSender: command.claimedSender }));
    return { messageId: r.id, replayed: r.replayed };
  }

  /**
   * The messages of a thread after a sequence number (default: after what this reader has confirmed receiving), oldest first. A reader that reconnects asks again from its cursor and gets
   * exactly what it has not confirmed. Only participants and the owner can read a thread; anyone else gets `undefined`, as for a thread that does not exist.
   */
  async read(by: Principal, query: { threadId: string; afterSeq?: number; limit?: number }): Promise<{ items: MessageView[]; lastSeq: number; deliveredSeq: number } | undefined> {
    const threadId = this.#threadId(query.threadId);
    const limit = query.limit ?? 50;
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > CONVERSATION_LIMITS.page) invalid("limit", `must be a whole number from 1 to ${CONVERSATION_LIMITS.page}`);
    if (query.afterSeq !== undefined && (!Number.isSafeInteger(query.afterSeq) || query.afterSeq < 0)) invalid("afterSeq", "must be a whole number, 0 or more");
    const found = await this.#runner.get("thread", threadId);
    const thread = found?.body as unknown as ThreadBody | undefined;
    const fresh = await this.#fresh(by.id);
    if (thread === undefined || fresh === undefined || !this.#mayRead(fresh, thread)) return undefined;
    const cursor = (await this.#runner.get("conversation-cursor", `${threadId}:${by.id}`))?.body as unknown as CursorBody | undefined;
    const deliveredSeq = cursor?.deliveredSeq ?? 0;
    let after = query.afterSeq ?? deliveredSeq;
    const items: MessageView[] = [];
    // Message IDs sort by thread and then sequence, so a thread's messages after a point are the start of the listing from that point. Messages the reader may not see are skipped, so more than one page may be read.
    for (let reads = 0; reads < 50 && items.length < limit; reads++) {
      const page = await this.#runner.list("message", { afterId: messageIdOf(threadId, after), limit: 100 });
      const mine = page.filter((m) => m.id.startsWith(threadId + "."));
      for (const m of mine) {
        after = (m.body as unknown as MessageBody).seq;
        if (!this.#visibleTo(fresh, m.body as unknown as MessageBody)) continue;
        if (items.length >= limit) break;
        const delivery = (await this.#runner.get("conversation-delivery", `${m.id}:${by.id}`))?.body as unknown as DeliveryBody | undefined;
        items.push({ ...view<MessageBody>(m), trust: "untrusted-content", ...(delivery === undefined ? {} : { delivery: delivery.state, availability: delivery.availability }) });
      }
      if (mine.length < page.length || page.length < 100) break;
    }
    return { items, lastSeq: thread.nextSeq - 1, deliveredSeq };
  }

  /**
   * The reader confirms it received everything up to `upToSeq` (at most 100 messages per call; it says if more remain). The cursor moves forward only; messages addressed to the reader in
   * that range become `delivered`, and its queue shrinks.
   */
  async acknowledge(by: Principal, command: NoActor & { threadId: string; upToSeq: number }): Promise<{ deliveredSeq: number; more: boolean }> {
    onlyKnown(command, ["commandId", "threadId", "upToSeq"]);
    const threadId = this.#threadId(command.threadId);
    if (!Number.isSafeInteger(command.upToSeq) || command.upToSeq < 1) invalid("upToSeq", "must be a whole number, 1 or more");
    const fresh = await this.#fresh(by.id);
    await this.#retrying(() => this.#runner.command("conversation.acknowledge", { commandId: scopedCommandId(by.id, command.commandId), actor: by.id }, async () => ({
      payload: { threadId, upToSeq: command.upToSeq },
      build: async () => {
        const found = await this.#runner.get("thread", threadId);
        const thread = found?.body as unknown as ThreadBody | undefined;
        if (found === undefined || thread === undefined || fresh === undefined || !this.#mayRead(fresh, thread)) throw new DomainError("forbidden", `${by.id} may not acknowledge in that thread`);
        if (command.upToSeq > thread.nextSeq - 1) throw new DomainError("invalid_command", `upToSeq: the thread has only ${thread.nextSeq - 1} messages`, { field: "upToSeq" });
        const cursorRef: AggregateRef = { kind: "conversation-cursor", id: `${threadId}:${by.id}` };
        const cursor = await this.#runner.get("conversation-cursor", cursorRef.id);
        const from = (cursor?.body as unknown as CursorBody | undefined)?.deliveredSeq ?? 0;
        const target = Math.min(command.upToSeq, from + CONVERSATION_LIMITS.ackBatch);
        const changes: Change[] = [];
        let delivered = 0;
        for (let seq = from + 1; seq <= target; seq++) {
          const d = await this.#runner.get("conversation-delivery", `${messageIdOf(threadId, seq)}:${by.id}`);
          if (d === undefined) continue;
          const body = d.body as unknown as DeliveryBody;
          if (body.state !== "accepted") continue;
          changes.push({ type: "update", ref: { kind: "conversation-delivery", id: d.id }, expectedRevision: d.revision, body: { ...body, state: "delivered", deliveredAt: this.#runner.now() } as unknown as JsonObject });
          delivered += 1;
        }
        const next: CursorBody = { threadId, principal: by.id, deliveredSeq: Math.max(from, target) };
        changes.push(cursor === undefined ? { type: "create", ref: cursorRef, body: next as unknown as JsonObject } : { type: "update", ref: cursorRef, expectedRevision: cursor.revision, body: next as unknown as JsonObject });
        if (delivered > 0) changes.push(await this.#inboxChange(by.id, threadId, -delivered));
        return { ref: cursorRef, creates: cursor === undefined, changes, detail: { threadId, deliveredSeq: next.deliveredSeq, delivered }, contention: async () => new DomainError("stale_revision", "the thread or the inbox changed meanwhile; acknowledge again") };
      },
    })));
    const deliveredSeq = ((await this.#runner.get("conversation-cursor", `${threadId}:${by.id}`))?.body as unknown as CursorBody | undefined)?.deliveredSeq ?? 0;
    return { deliveredSeq, more: deliveredSeq < command.upToSeq };
  }

  /** The recipient says it dealt with a message it received. A message must be delivered first; a reply marks it answered, which is not the same as handled or done. */
  async markHandled(by: Principal, command: NoActor & { messageId: string }): Promise<void> {
    onlyKnown(command, ["commandId", "messageId"]);
    const messageId = this.#messageId(command.messageId);
    const early = (await this.#runner.get("conversation-delivery", `${messageId}:${by.id}`))?.body as unknown as DeliveryBody | undefined;
    if (early === undefined) throw new DomainError("forbidden", `${by.id} has no such message`);
    // Already handled (or answered): nothing to record.
    if (early.state === "handled" || early.state === "answered") return;
    await this.#retrying(() => this.#runner.command("conversation.handled", { commandId: scopedCommandId(by.id, command.commandId), actor: by.id }, async () => ({
      payload: { messageId },
      build: async () => {
        const d = await this.#runner.get("conversation-delivery", `${messageId}:${by.id}`);
        const body = d?.body as unknown as DeliveryBody | undefined;
        if (d === undefined || body === undefined) throw new DomainError("forbidden", `${by.id} has no such message`);
        if (body.state === "accepted") throw new DomainError("invalid_command", "the message has not been confirmed as delivered; acknowledge it first", { field: "messageId" });
        const ref: AggregateRef = { kind: "conversation-delivery", id: d.id };
        const next: DeliveryBody = body.state === "delivered" ? { ...body, state: "handled", handledAt: this.#runner.now() } : body;
        return { ref, creates: false, changes: [{ type: "update", ref, expectedRevision: d.revision, body: next as unknown as JsonObject }], detail: { messageId }, contention: async () => new DomainError("stale_revision", "the message changed meanwhile; try again") };
      },
    })));
  }

  /** Threads with messages this principal has not confirmed, with how many, for the principal itself. */
  async unread(by: Principal): Promise<{ undelivered: number; threads: { threadId: string; count: number }[] }> {
    const inbox = (await this.#runner.get("conversation-inbox", by.id))?.body as unknown as InboxBody | undefined;
    return { undelivered: inbox?.undelivered ?? 0, threads: Object.entries(inbox?.threads ?? {}).map(([threadId, count]) => ({ threadId, count })).sort((a, b) => (a.threadId < b.threadId ? -1 : 1)) };
  }

  /** A thread, for a participant or the owner. */
  async thread(by: Principal, threadId: string): Promise<View<ThreadBody> | undefined> {
    const id = this.#threadId(threadId);
    const found = await this.#runner.get("thread", id);
    const fresh = await this.#fresh(by.id);
    if (found === undefined || fresh === undefined || !this.#mayRead(fresh, found.body as unknown as ThreadBody)) return undefined;
    return view<ThreadBody>(found);
  }

  /** The threads this principal takes part in (all of them, for the owner), oldest ID first, paged. */
  async threads(by: Principal, page: { afterId?: string; limit?: number } = {}): Promise<{ items: View<ThreadBody>[]; next?: string }> {
    const limit = page.limit ?? 20;
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > CONVERSATION_LIMITS.page) invalid("limit", `must be a whole number from 1 to ${CONVERSATION_LIMITS.page}`);
    const fresh = await this.#fresh(by.id);
    if (fresh === undefined) return { items: [] };
    const items: View<ThreadBody>[] = [];
    let after = page.afterId;
    for (let reads = 0; reads < 20; reads++) {
      const chunk = await this.#runner.list("thread", { ...(after === undefined ? {} : { afterId: after }), limit: 200 });
      for (const t of chunk) {
        after = t.id;
        if (!this.#mayRead(fresh, t.body as unknown as ThreadBody)) continue;
        items.push(view<ThreadBody>(t));
        if (items.length >= limit) return { items, next: t.id };
      }
      if (chunk.length < 200) return { items };
    }
    return { items, ...(after === undefined ? {} : { next: after }) };
  }

  /** The starter or the owner closes a thread; nothing more can be sent in it. */
  async close(by: Principal, command: NoActor & { threadId: string; expectedRevision: number }): Promise<void> {
    onlyKnown(command, ["commandId", "threadId", "expectedRevision"]);
    const id = this.#threadId(command.threadId);
    const expected = checkRevision(command.expectedRevision);
    await this.#runner.command("thread.close", { commandId: scopedCommandId(by.id, command.commandId), actor: by.id }, async () => ({
      payload: { threadId: id, expectedRevision: expected },
      build: async () => {
        const found = await this.#runner.get("thread", id);
        const thread = found?.body as unknown as ThreadBody | undefined;
        if (found === undefined || thread === undefined || !(by.kind === "owner" || by.id === thread.startedBy)) throw new DomainError("forbidden", `${by.id} may not close that thread`);
        if (found.revision !== expected) throw new DomainError("stale_revision", `thread ${id} is at revision ${found.revision}, not ${expected}`, { currentRevision: found.revision });
        if (thread.state !== "open") throw new DomainError("invalid_command", `thread ${id} is already closed`, { field: "threadId" });
        const ref: AggregateRef = { kind: "thread", id };
        return { ref, creates: false, changes: [{ type: "update", ref, expectedRevision: found.revision, body: { ...thread, state: "closed", closedAt: this.#runner.now(), closedBy: by.id } as unknown as JsonObject }], detail: { threadId: id } };
      },
    }));
  }

  // ---- the send path ------------------------------------------------------------------------------------------------------

  async #append(by: Principal, input: {
    commandId: string; scoped: string; threadId: string; newThread?: { projectId: string; subject: string };
    to?: readonly string[] | undefined; kind?: MessageKind | undefined; text: unknown; replyTo?: unknown; priority?: Priority | undefined; claimedSender?: unknown;
  }) {
    const kind = input.kind === undefined ? "message" : KINDS.includes(input.kind) ? input.kind : invalid("kind", "must be message, question, answer, action-request or notice");
    const priority = input.priority === undefined ? "routine" : input.priority === "routine" || input.priority === "urgent" ? input.priority : invalid("priority", "must be routine or urgent");
    const body = text(input.text, "text", { min: 1, max: CONVERSATION_LIMITS.text, multiline: true });
    const cleaned = redactText(body);
    const claimed = input.claimedSender === undefined ? undefined : text(input.claimedSender, "claimedSender", { min: 1, max: CONVERSATION_LIMITS.claimed });
    if (claimed !== undefined && !by.id.startsWith("client:") && claimed !== by.id) invalid("claimedSender", "only an external client can speak for someone else; an agent speaks as itself");
    if (by.id.startsWith("client:") && !CLIENT_KINDS.includes(kind)) invalid("kind", `an external client cannot send a ${kind}`);
    const replyTo = input.replyTo === undefined ? undefined : this.#messageId(input.replyTo);
    if (replyTo !== undefined && !replyTo.startsWith(input.threadId + ".")) invalid("replyTo", "names a message in another thread");
    const named = input.to === undefined ? undefined : this.#recipients(input.to);
    return this.#runner.command(input.newThread === undefined ? "message.send" : "thread.start", { commandId: input.scoped, actor: by.id }, async () => ({
      payload: { threadId: input.threadId, ...(input.newThread === undefined ? {} : { projectId: input.newThread.projectId, subject: input.newThread.subject }), to: named ?? null, kind, priority, text: body, replyTo: replyTo ?? null, claimedSender: claimed ?? null },
      build: async () => {
        const now = this.#runner.now();
        const sender = await this.#fresh(by.id);
        if (sender === undefined) throw new DomainError("unauthenticated", "the credential was not accepted");
        // The thread: new, or read now (its revision orders the sends).
        let thread: ThreadBody;
        let threadRevision = 0;
        if (input.newThread !== undefined) {
          if ((await this.#runner.get("project", input.newThread.projectId)) === undefined) throw new DomainError("forbidden", `${by.id} may not start a thread in that project`);
          thread = { projectId: input.newThread.projectId, subject: input.newThread.subject, participants: [by.id], startedBy: by.id, state: "open", nextSeq: 1, turnsWithoutOwner: 0, createdAt: now };
          if (!allows(sender, "conversation.start", thread.projectId)) throw new DomainError("forbidden", `${by.id} may not start a thread in that project`);
        } else {
          const found = await this.#runner.get("thread", input.threadId);
          const existing = found?.body as unknown as ThreadBody | undefined;
          if (found === undefined || existing === undefined || !(by.kind === "owner" || existing.participants.includes(by.id)) || !allows(sender, "conversation.send", existing.projectId)) throw new DomainError("forbidden", `${by.id} may not send in that thread`);
          if (existing.state !== "open") throw new DomainError("invalid_command", `thread ${input.threadId} is closed`, { field: "threadId" });
          thread = existing; threadRevision = found.revision;
        }
        const projectId = thread.projectId;
        if (kind === "action-request" && !allows(sender, "conversation.request-action", projectId)) throw new DomainError("forbidden", `${by.id} may not send action requests in this project`);
        if (priority === "urgent" && !allows(sender, "conversation.urgent", projectId)) throw new DomainError("forbidden", `${by.id} may not send urgent messages in this project`);
        const state = await this.#availability(by.id);
        if (state !== "available") throw new DomainError("unavailable", `${by.id} is ${state}; it cannot send until it is resumed`);
        // Who it is for: those named, or everyone else in the thread.
        const to = (named ?? thread.participants.filter((p) => p !== by.id));
        if (to.length === 0) invalid("to", "names no one to send to");
        if (to.includes(by.id)) invalid("to", "a message cannot be addressed to its sender");
        const participants = [...thread.participants];
        const queued: Record<string, "ready" | "queued"> = {};
        for (const recipient of to) {
          if (!thread.participants.includes(recipient) && !(await this.#reachable(sender, recipient, projectId))) throw new DomainError("forbidden", `${recipient} cannot be addressed by ${by.id} in this project`);
          if (!participants.includes(recipient)) participants.push(recipient);
          queued[recipient] = (await this.#availability(recipient)) === "available" ? "ready" : "queued";
        }
        if (participants.length > CONVERSATION_LIMITS.participants) throw new DomainError("invalid_command", `a thread has at most ${CONVERSATION_LIMITS.participants} participants`, { field: "to" });
        // Replies and the loop guards.
        let depth = 0;
        let parentDelivery: Aggregate | undefined;
        if (replyTo !== undefined) {
          const parent = await this.#runner.get("message", replyTo);
          // A message the sender cannot see reads exactly like one that does not exist.
          if (parent === undefined || !this.#visibleTo(sender, parent.body as unknown as MessageBody)) throw new DomainError("invalid_command", `replyTo: ${replyTo} is not a message`, { field: "replyTo" });
          depth = (parent.body as unknown as MessageBody).depth + 1;
          if (depth > CONVERSATION_LIMITS.depth) throw new DomainError("unavailable", `this chain of replies is ${CONVERSATION_LIMITS.depth} deep; it looks like a loop. Ask the owner, or start a new thread`);
          parentDelivery = await this.#runner.get("conversation-delivery", `${replyTo}:${by.id}`);
        }
        const turns = by.kind === "owner" ? 0 : thread.turnsWithoutOwner + 1;
        if (turns > CONVERSATION_LIMITS.turnsWithoutOwner) throw new DomainError("unavailable", `this thread has had ${CONVERSATION_LIMITS.turnsWithoutOwner} messages without the owner; it looks like a loop. Ask the owner to join or to close it`);
        // The sender's rate.
        const rateRef: AggregateRef = { kind: "conversation-rate", id: by.id };
        const rate = await this.#runner.get("conversation-rate", by.id);
        const old = rate?.body as unknown as RateBody | undefined;
        const newWindow = old === undefined || Date.parse(now) - Date.parse(old.windowStart) >= RATE_WINDOW_MS;
        const count = newWindow || old === undefined ? 1 : old.count + 1;
        if (count > CONVERSATION_LIMITS.perMinute) throw new DomainError("unavailable", `${by.id} has sent ${CONVERSATION_LIMITS.perMinute} messages in the last minute; slow down`);
        const nextRate: RateBody = { windowStart: newWindow || old === undefined ? now : old.windowStart, count };
        // Recipients' queues.
        const changes: Change[] = [];
        const seq = thread.nextSeq;
        if (seq > 99_999_999) throw new DomainError("unavailable", `thread ${input.threadId} is full; start a new one`);
        const messageId = messageIdOf(input.threadId, seq);
        const msg: MessageBody = {
          threadId: input.threadId, seq, sender: by.id, senderKind: by.kind, ...(claimed === undefined ? {} : { claimedSender: claimed }), to, kind, priority, ...(replyTo === undefined ? {} : { replyTo }),
          depth, text: cleaned, redacted: cleaned !== body, sentAt: now, needsAuthorization: kind === "action-request",
        };
        const nextThread: ThreadBody = { ...thread, participants, nextSeq: seq + 1, turnsWithoutOwner: turns };
        const threadRef: AggregateRef = { kind: "thread", id: input.threadId };
        changes.push(input.newThread === undefined ? { type: "update", ref: threadRef, expectedRevision: threadRevision, body: nextThread as unknown as JsonObject } : { type: "create", ref: threadRef, body: nextThread as unknown as JsonObject });
        const messageRef: AggregateRef = { kind: "message", id: messageId };
        changes.push({ type: "create", ref: messageRef, body: msg as unknown as JsonObject });
        for (const recipient of to) {
          const delivery: DeliveryBody = { messageId, threadId: input.threadId, seq, recipient, state: "accepted", availability: queued[recipient]!, acceptedAt: now };
          changes.push({ type: "create", ref: { kind: "conversation-delivery", id: `${messageId}:${recipient}` }, body: delivery as unknown as JsonObject });
          changes.push(await this.#inboxChange(recipient, input.threadId, +1, true));
        }
        changes.push(rate === undefined ? { type: "create", ref: rateRef, body: nextRate as unknown as JsonObject } : { type: "update", ref: rateRef, expectedRevision: rate.revision, body: nextRate as unknown as JsonObject });
        if (parentDelivery !== undefined) {
          const pd = parentDelivery.body as unknown as DeliveryBody;
          if (pd.state !== "answered") {
            changes.push({ type: "update", ref: { kind: "conversation-delivery", id: parentDelivery.id }, expectedRevision: parentDelivery.revision, body: { ...pd, state: "answered", answeredAt: now, answeredBy: messageId, ...(pd.deliveredAt === undefined ? { deliveredAt: now } : {}) } as unknown as JsonObject });
            // Answering a message the replier had not confirmed is also receiving it: it leaves the replier's waiting count.
            if (pd.state === "accepted") changes.push(await this.#inboxChange(by.id, input.threadId, -1));
          }
        }
        return { ref: messageRef, creates: true, changes, detail: { threadId: input.threadId, seq, kind, to: to.length, sender: by.id }, contention: async () => new DomainError("stale_revision", `thread ${input.threadId} changed meanwhile; send again`) };
      },
    }));
  }

  /** The recipient's inbox record changed by `by` messages in a thread, with the check that a queue is not over its limit when adding. */
  async #inboxChange(recipient: string, threadId: string, by: number, enforce = false): Promise<Change> {
    const found = await this.#runner.get("conversation-inbox", recipient);
    const old = found?.body as unknown as InboxBody | undefined;
    const undelivered = Math.max(0, (old?.undelivered ?? 0) + by);
    if (enforce && by > 0 && undelivered > CONVERSATION_LIMITS.queue) throw new DomainError("unavailable", `${recipient} already has ${CONVERSATION_LIMITS.queue} messages waiting; try later`);
    const threads = { ...(old?.threads ?? {}) };
    const here = Math.max(0, (threads[threadId] ?? 0) + by);
    if (here === 0) delete threads[threadId]; else threads[threadId] = here;
    const body: InboxBody = { undelivered, threads };
    const ref: AggregateRef = { kind: "conversation-inbox", id: recipient };
    return found === undefined ? { type: "create", ref, body: body as unknown as JsonObject } : { type: "update", ref, expectedRevision: found.revision, body: body as unknown as JsonObject };
  }

  // ---- internals ------------------------------------------------------------------------------------------------------------

  #threadId(value: unknown): string { return typeof value === "string" && THREAD_ID.test(value) ? value : invalid("threadId", "is not a thread ID"); }
  #messageId(value: unknown): string { return typeof value === "string" && MESSAGE_ID.test(value) ? value : invalid("messageId", "is not a message ID"); }

  #recipients(value: unknown): string[] {
    if (!Array.isArray(value) || value.length === 0 || value.length > CONVERSATION_LIMITS.recipients) return invalid("to", `must be a list of 1 to ${CONVERSATION_LIMITS.recipients} principal IDs`);
    const out = value.map((v, i) => (typeof v === "string" && PRINCIPAL.test(v) ? v : invalid(`to[${i}]`, "must be a principal ID such as agent:agt-... or client:name")));
    if (new Set(out).size !== out.length) invalid("to", "must not repeat a recipient");
    return out;
  }

  /** The owner, or a participant who still holds a conversation right in the thread's project (revoking the grants ends access without waiting for the credential to go). */
  #mayRead(reader: Principal, thread: ThreadBody): boolean {
    return reader.kind === "owner" || (thread.participants.includes(reader.id) && (allows(reader, "conversation.receive", thread.projectId) || allows(reader, "conversation.send", thread.projectId)));
  }

  /** A participant sees the messages it sent and the ones addressed to it, not the rest of the thread (and so nothing sent before it was added that was not for it); the owner sees all. */
  #visibleTo(reader: Principal, m: MessageBody): boolean { return reader.kind === "owner" || m.sender === reader.id || m.to.includes(reader.id); }

  /** Whether the sender may address this principal in this project: the owner always can be reached; an agent or client only if it is active and holds `conversation.receive` there. One answer for unknown and unreachable. */
  async #reachable(sender: Principal, recipient: string, projectId: string): Promise<boolean> {
    void sender; void projectId;
    const fresh = await this.#fresh(recipient);
    if (fresh === undefined) return false;
    // The owner can always be reached by someone who may speak in the project; anyone else must have said they receive here.
    if (fresh.kind === "owner") return true;
    return (fresh.kind === "agent" || fresh.kind === "client") && allows(fresh, "conversation.receive", projectId);
  }

  /** The principal as stored now, with grants and restrictions loaded now. `undefined` if it is not an active principal. */
  async #fresh(principalId: string): Promise<Principal | undefined> {
    const found = await this.#runner.get("principal", principalId);
    const body = found?.body as unknown as PrincipalBody | undefined;
    if (found === undefined || body === undefined || body.state !== "active") return undefined;
    return effectiveOf(this.#runner, { id: found.id, kind: body.kind, name: body.name, grants: body.grants }, this.#runner.now());
  }

  /** Two senders at the same moment meet a revision check on the thread or a counter; the loser reads again. Only that race is retried: a command ID reused for a different command fails at once. */
  async #retrying<T>(run: () => Promise<T>): Promise<T> {
    for (let attempt = 1; ; attempt++) {
      try { return await run(); } catch (error) {
        if (!(error instanceof DomainError) || error.code !== "stale_revision" || attempt >= 8 || error.currentRevision !== undefined) throw error;
        await new Promise((resolve) => setTimeout(resolve, Math.round(Math.random() * 10 * attempt)));
      }
    }
  }
}
