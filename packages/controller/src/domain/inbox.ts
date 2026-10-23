import { canonicalJson, sha256 } from "../storage/json.js";
import type { AggregateRef, Change, ControllerStorage, JsonObject } from "../storage/types.js";
import { assignmentIdOf, type AssignmentBody, type Owner } from "./assignment-model.js";
import type { AssignmentEvent, AssignmentService } from "./assignments.js";
import type { DeliveryHandler } from "./delivery.js";
import { DomainError, isDomainError } from "./errors.js";
import { derivedId } from "./ids.js";
import { onlyKnown, text, type TaskBody, type View } from "./model.js";
import { CommandRunner, view, type CommandMeta, type CommandResult, type RunnerOptions } from "./runner.js";

export type InboxState = "received" | "admitted" | "settled";
export type AdmissionOutcome = "admitted" | "superseded" | "ignored" | "already_active" | "task_closed";
/** What `admitAssignment` returns: a recorded outcome, or `deferred` (the task is not ready yet; nothing is recorded and the call can be repeated later). */
export type AdmissionResult = AdmissionOutcome | "deferred";

/**
 * One message the inbox holds (kind `inbox-message`; ID derived from source and delivery ID, so a message has one record however often it
 * arrives). `payload` is kept so the receipt can be audited and a changed payload under the same delivery ID can be recognised.
 */
export interface InboxMessageBody {
  readonly source: string;
  readonly deliveryId: string;
  readonly orderingKey?: string;
  /** The sender's revision of what the message announces, when it has one (an assignment revision). Informational: decisions use current state. */
  readonly sequence?: number;
  readonly payloadDigest: string;
  readonly payload: JsonObject;
  readonly state: InboxState;
  readonly receivedAt: string;
  /** What admission decided and, if it created one, the attempt. */
  readonly admission?: { readonly outcome: AdmissionOutcome; readonly attemptId?: string };
  readonly settlement?: { readonly outcome: string; readonly detail?: string };
}

export interface IncomingMessage {
  readonly source: string;
  readonly deliveryId: string;
  readonly orderingKey?: string;
  readonly sequence?: number;
  readonly payload: JsonObject;
}

export interface AdmitMessage extends CommandMeta { readonly messageId: string }
export interface SettleMessage extends CommandMeta {
  readonly messageId: string;
  readonly expectedRevision: number;
  readonly outcome: "completed" | "failed" | "abandoned";
  readonly detail?: string;
}
export interface Admission { readonly messageId: string; readonly outcome: AdmissionResult; readonly attemptId?: string; readonly replayed: boolean }

/** The actor of the commands an admission issues. They derive from the message, not from the caller, so two callers admitting one message issue identical commands and the second is answered by the first. */
const INBOX_ACTOR = "inbox";
export const INBOX_LIMITS = { source: 80, deliveryId: 200, payloadBytes: 64 * 1024, detail: 1000 } as const;
/** The source of the items the event watchers put in the inbox (card H13). They are not assignment messages: the reconciler leaves them alone and the wake consumer takes them. */
export const EVENTS_INBOX_SOURCE = "events";
const MESSAGE_ID = /^inb-[a-z2-7]{20}$/;
export const inboxMessageId = (source: string, deliveryId: string): string => derivedId("inb", `${source}\0${deliveryId}`);

/**
 * The durable inbox (card S04): the receiving side of at-least-once delivery.
 *
 * - **Receipt.** `receive` writes the message record and returns only after that commit; `handler` makes it a `DeliveryHandler`, so a
 *   sender (the `DeliveryDispatcher` of S03) is told "accepted" only for a message that is durably held. A repeat of a delivery is
 *   answered from the record (`replayed`); the same delivery ID with a different payload is `payload_changed` and changes nothing.
 * - **Admission.** `admitAssignment` turns an assignment message into an attempt, once. It decides from the *current* assignment, not from
 *   the order messages arrive in: a message for a superseded generation or an assignment that moved on settles as `superseded`; one for a
 *   task that already has an active attempt settles as `already_active`; the attempt's command ID derives from the message, so a duplicate
 *   or a crashed-and-repeated admission finds its own attempt instead of creating a second.
 * - **Settlement.** `settle` records how an admitted message ended. Every step is a revisioned, idempotent command with an audit record.
 */
export class InboxService {
  readonly #runner: CommandRunner;
  readonly #assignments: AssignmentService;

  private constructor(runner: CommandRunner, assignments: AssignmentService) {
    this.#runner = runner;
    this.#assignments = assignments;
  }

  static withEpoch(storage: ControllerStorage, epoch: number, assignments: AssignmentService, options: RunnerOptions = {}): InboxService {
    if (assignments.epoch !== epoch) throw new DomainError("invalid_command", "epoch: must be the epoch the assignment service writes under", { field: "epoch" });
    return new InboxService(new CommandRunner(storage, epoch, options), assignments);
  }

  /** Durably receives a message. Resolves only after the record is committed (or found to be committed already). */
  async receive(message: IncomingMessage): Promise<CommandResult> {
    if (message === null || typeof message !== "object") throw new DomainError("invalid_command", "a message is an object");
    onlyKnown(message, ["source", "deliveryId", "orderingKey", "sequence", "payload"]);
    const source = text(message.source, "source", { min: 1, max: INBOX_LIMITS.source });
    const deliveryId = text(message.deliveryId, "deliveryId", { min: 1, max: INBOX_LIMITS.deliveryId });
    const orderingKey = message.orderingKey === undefined ? undefined : text(message.orderingKey, "orderingKey", { min: 1, max: 200 });
    if (message.sequence !== undefined && (!Number.isSafeInteger(message.sequence) || message.sequence < 0)) throw new DomainError("invalid_command", "sequence: must be a whole number", { field: "sequence" });
    if (message.payload === null || typeof message.payload !== "object" || Array.isArray(message.payload)) throw new DomainError("invalid_command", "payload: must be a JSON object", { field: "payload" });
    const canonical = canonicalJson(message.payload);
    if (canonical.length > INBOX_LIMITS.payloadBytes) throw new DomainError("invalid_command", `payload: must be at most ${INBOX_LIMITS.payloadBytes} characters`, { field: "payload" });
    const id = inboxMessageId(source, deliveryId);
    const payloadDigest = sha256(canonical);
    try {
      return await this.#runner.command("inbox.receive", { commandId: `rcv:${id}`, actor: source }, async () => ({
        payload: { source, deliveryId, payloadDigest, ...(orderingKey === undefined ? {} : { orderingKey }), ...(message.sequence === undefined ? {} : { sequence: message.sequence }) },
        build: async () => {
          const body: InboxMessageBody = {
            source, deliveryId, ...(orderingKey === undefined ? {} : { orderingKey }), ...(message.sequence === undefined ? {} : { sequence: message.sequence }),
            payloadDigest, payload: message.payload, state: "received", receivedAt: this.#runner.now(),
          };
          const ref: AggregateRef = { kind: "inbox-message", id };
          return { ref, creates: true, changes: [{ type: "create", ref, body: body as unknown as JsonObject }], detail: { source, deliveryId } };
        },
      }));
    } catch (error) {
      if (isDomainError(error, "command_conflict")) throw new DomainError("payload_changed", `delivery ${deliveryId} from ${source} was already received with different content (payload or metadata); nothing was changed`, { cause: error });
      throw error;
    }
  }

  /** A `DeliveryHandler` that receives each delivery into this inbox and acknowledges it only once it is durably held. */
  handler(source: string): DeliveryHandler {
    return async (delivery) => {
      const received = await this.receive({
        source, deliveryId: delivery.deliveryId, payload: delivery.payload, sequence: delivery.aggregateRevision,
        ...(delivery.orderingKey === undefined ? {} : { orderingKey: delivery.orderingKey }),
      });
      return { messageId: received.id, revision: received.revision };
    };
  }

  /**
   * Admits an assignment message once. Returns the decision; repeating it (a duplicate message, a retry after a crash, a concurrent call)
   * returns the same decision and never a second attempt.
   */
  async admitAssignment(command: AdmitMessage): Promise<Admission> {
    if (command === null || typeof command !== "object") throw new DomainError("invalid_command", "a command is an object");
    onlyKnown(command, ["commandId", "actor", "messageId"]);
    const messageId = typeof command.messageId === "string" && MESSAGE_ID.test(command.messageId) ? command.messageId : invalid("messageId", "is not an inbox message ID");
    text(command.actor, "actor", { min: 1, max: 120 });
    const attemptCommand = `adm:${messageId}`;
    const myAttempt = derivedId("att", attemptCommand);
    for (let tries = 0; tries < 5; tries++) {
      const message = await this.#message(messageId);
      if (message.state !== "received") return this.#recorded(message);
      const event = message.payload as unknown as Partial<AssignmentEvent>;
      let decision: Decision | undefined;
      const mine = await this.#runner.get("attempt", myAttempt);
      if (mine !== undefined) decision = { outcome: "admitted", attemptId: myAttempt };
      else if (event.change !== "assigned" && event.change !== "transferred") decision = { outcome: "ignored" };
      else {
        const found = typeof event.taskId === "string" ? await this.#runner.get("assignment", assignmentIdOf(event.taskId)) : undefined;
        const current = found?.body as unknown as AssignmentBody | undefined;
        const owner = event.owner as Owner | undefined;
        // A decision that says "no attempt was made" is recorded only if the assignment is still as it was read, so a concurrent admission of this very message cannot be contradicted.
        const guard = found === undefined ? undefined : { assignmentId: found.id, revision: found.revision };
        const task = typeof event.taskId === "string" ? await this.#runner.get("task", event.taskId) : undefined;
        const taskState = (task?.body as unknown as TaskBody | undefined)?.state;
        // The active attempt may be this very message's, created by a concurrent call between the check above and the read of the assignment: that is an admission whatever has happened to the task since,
        // and never another owner's attempt (its ID is derived from this message).
        if (current?.activeAttemptId === myAttempt) decision = { outcome: "admitted", attemptId: myAttempt };
        else if (found === undefined || current === undefined || owner === undefined || current.state !== "assigned" || current.owner === undefined || current.generation !== event.generation || current.owner.kind !== owner.kind || current.owner.id !== owner.id) decision = { outcome: "superseded", ...(guard === undefined ? {} : { guard }) };
        else if (taskState === "done" || taskState === "cancelled") decision = { outcome: "task_closed", ...(guard === undefined ? {} : { guard }) };
        else if (taskState !== "ready" && taskState !== "in_progress") return { messageId, outcome: "deferred", replayed: false };
        else if (current.activeAttemptId !== undefined) decision = { outcome: "already_active", attemptId: current.activeAttemptId, ...(guard === undefined ? {} : { guard }) };
        else {
          try {
            const admitted = await this.#assignments.admitAttempt({ commandId: attemptCommand, actor: INBOX_ACTOR, taskId: event.taskId as string, expectedRevision: found.revision, generation: current.generation, owner });
            decision = { outcome: "admitted", attemptId: admitted.id };
          } catch (error) {
            // Lost a race for the writer slot, or the assignment or task moved since it was read: look again at the new state (the task's state was checked above, so a refusal here is a race).
            if (isDomainError(error, "stale_revision") || isDomainError(error, "invalid_command") || isDomainError(error, "fenced")) continue;
            throw error;
          }
        }
      }
      const marked = await this.#mark(message, decision);
      if (marked !== undefined) return marked;
    }
    throw new DomainError("unavailable", `message ${messageId} could not be admitted: the assignment kept changing`);
  }

  /** Records how an admitted message ended. */
  settle(command: SettleMessage): Promise<CommandResult> {
    return this.#runner.command("inbox.settle", command, async () => {
      onlyKnown(command, ["commandId", "actor", "messageId", "expectedRevision", "outcome", "detail"]);
      const messageId = typeof command.messageId === "string" && MESSAGE_ID.test(command.messageId) ? command.messageId : invalid("messageId", "is not an inbox message ID");
      if (!Number.isSafeInteger(command.expectedRevision) || command.expectedRevision < 1) invalid("expectedRevision", "must be a whole number of at least 1");
      if (command.outcome !== "completed" && command.outcome !== "failed" && command.outcome !== "abandoned") invalid("outcome", "must be completed, failed or abandoned");
      const detail = command.detail === undefined ? undefined : text(command.detail, "detail", { min: 1, max: INBOX_LIMITS.detail, multiline: true });
      return {
        payload: { messageId, expectedRevision: command.expectedRevision, outcome: command.outcome, ...(detail === undefined ? {} : { detail }) },
        build: async () => {
          const current = await this.#runner.existing("inbox-message", messageId, command.expectedRevision);
          const body = current.body as unknown as InboxMessageBody;
          if (body.state !== "admitted") throw new DomainError("invalid_command", `message ${messageId} is ${body.state}; only an admitted message can be settled`, { field: "messageId" });
          const next: InboxMessageBody = { ...body, state: "settled", settlement: { outcome: command.outcome, ...(detail === undefined ? {} : { detail }) } };
          const ref: AggregateRef = { kind: "inbox-message", id: messageId };
          return { ref, creates: false, changes: [{ type: "update", ref, expectedRevision: current.revision, body: next as unknown as JsonObject }], detail: { outcome: command.outcome } };
        },
      };
    });
  }

  async getMessage(messageId: string): Promise<View<InboxMessageBody> | undefined> {
    const found = await this.#runner.get("inbox-message", messageId);
    return found === undefined ? undefined : view<InboxMessageBody>(found);
  }

  /** The message for one delivery, if it has been received. */
  getByDelivery(source: string, deliveryId: string): Promise<View<InboxMessageBody> | undefined> {
    return this.getMessage(inboxMessageId(source, deliveryId));
  }

  async #message(id: string): Promise<View<InboxMessageBody>> {
    const found = await this.getMessage(id);
    if (found === undefined) throw new DomainError("not_found", `inbox message ${id} does not exist`);
    return found;
  }

  #recorded(message: View<InboxMessageBody>): Admission {
    const admission = message.admission;
    if (admission === undefined) throw new DomainError("integrity", `message ${message.id} is ${message.state} but records no admission`);
    return { messageId: message.id, outcome: admission.outcome, ...(admission.attemptId === undefined ? {} : { attemptId: admission.attemptId }), replayed: true };
  }

  /** Records the decision on the message. Undefined if another caller recorded one first (the caller loops and returns that). */
  async #mark(message: View<InboxMessageBody>, decision: Decision): Promise<Admission | undefined> {
    const settledNow = decision.outcome !== "admitted";
    try {
      await this.#runner.command("inbox.admit", { commandId: `mark:${message.id}`, actor: INBOX_ACTOR }, async () => ({
        payload: { messageId: message.id, outcome: decision.outcome, ...(decision.attemptId === undefined ? {} : { attemptId: decision.attemptId }), ...(decision.guard === undefined ? {} : { assignmentRevision: decision.guard.revision }) },
        build: async () => {
          const current = await this.#runner.existing("inbox-message", message.id, message.revision);
          const body = current.body as unknown as InboxMessageBody;
          const admission = { outcome: decision.outcome, ...(decision.attemptId === undefined ? {} : { attemptId: decision.attemptId }) };
          const next: InboxMessageBody = { ...body, state: settledNow ? "settled" : "admitted", admission, ...(settledNow ? { settlement: { outcome: decision.outcome } } : {}) };
          const ref: AggregateRef = { kind: "inbox-message", id: message.id };
          const guard: Change[] = decision.guard === undefined ? [] : [{ type: "check", ref: { kind: "assignment", id: decision.guard.assignmentId }, expectedRevision: decision.guard.revision }];
          return { ref, creates: false, changes: [{ type: "update", ref, expectedRevision: current.revision, body: next as unknown as JsonObject }, ...guard], detail: { outcome: decision.outcome } };
        },
      }));
    } catch (error) {
      // Another caller recorded a decision first (the message moved on), or this one's mark conflicts with theirs: take theirs.
      if (isDomainError(error, "stale_revision") || isDomainError(error, "command_conflict")) {
        const now = await this.#message(message.id);
        return now.state === "received" ? undefined : this.#recorded(now);
      }
      throw error;
    }
    return { messageId: message.id, outcome: decision.outcome, ...(decision.attemptId === undefined ? {} : { attemptId: decision.attemptId }), replayed: false };
  }
}

interface Decision { readonly outcome: AdmissionOutcome; readonly attemptId?: string; readonly guard?: { readonly assignmentId: string; readonly revision: number } }

const invalid = (field: string, message: string): never => { throw new DomainError("invalid_command", `${field}: ${message}`, { field }); };
