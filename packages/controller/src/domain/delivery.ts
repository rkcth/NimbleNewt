import { setTimeout as sleep } from "node:timers/promises";
import { commitOperation } from "../storage/commit.js";
import { isStorageError } from "../storage/errors.js";
import type { AggregateRef, ControllerStorage, DeliveryClaim, JsonObject, OperationInput } from "../storage/types.js";
import { DomainError } from "./errors.js";
import { mapStorageError } from "./runner.js";

/** One message handed to the handler. `deliveryId` is the message's identity: the same message arrives again after a crash or a lost receipt. */
export interface Delivery {
  readonly deliveryId: string;
  readonly orderingKey?: string;
  readonly aggregate: AggregateRef;
  readonly aggregateRevision: number;
  readonly payload: JsonObject;
  /** 1 for the first try. */
  readonly attempt: number;
}

/**
 * Hands one message to its destination and resolves when the destination has durably accepted it (a receipt, not a hope). The result is
 * stored as the delivery's receipt. It must tolerate the same `deliveryId` more than once: delivery is at least once, and the receipt
 * can only be written after the handler returns.
 */
export type DeliveryHandler = (delivery: Delivery) => Promise<JsonObject | void>;

export interface DispatcherOptions {
  readonly destination: string;
  /** Names this dispatcher in claims. */
  readonly claimant: string;
  readonly handler: DeliveryHandler;
  readonly clock?: () => string;
  /** How long a claim lasts before another dispatcher may take the message. Default one minute; must exceed the handler's worst case. */
  readonly leaseMs?: number;
  /** Messages claimed per pass. Default 10. */
  readonly batch?: number;
  /** Delay before the next try after attempt number `attempt` failed. Default 1 s doubling to 60 s. */
  readonly backoffMs?: (attempt: number) => number;
  readonly attempts?: number;
  readonly pause?: (attempt: number) => Promise<void>;
  /** How long a held message waits before it is looked at again. Default 5 minutes. */
  readonly holdBackoffMs?: number;
  /** A held message is given back without calling the handler (for example while a blocker on it is open). */
  readonly isHeld?: (claim: DeliveryClaim) => Promise<boolean>;
  /**
   * Called when the handler failed (card S07, bounded retry). Returns `hold` when the message has used up its allowed failures (the hook has
   * opened the visible blocker): it then waits `holdBackoffMs` instead of the normal backoff. Counting failures, not claims, is the hook's job:
   * a claim that only found the message held is not a failure.
   */
  readonly onFailure?: (claim: DeliveryClaim, reason: string) => Promise<"retry" | "hold">;
}

export interface PassResult {
  readonly delivered: number;
  /** Messages whose handler failed (or whose receipt could not be recorded) and will be tried again. */
  readonly failed: number;
  /** Messages another dispatcher took over while this one held them; nothing was recorded for them here. */
  readonly superseded: number;
  /** Messages given back without being handed over because they are held or exhausted. */
  readonly held: number;
}

const defaultBackoff = (attempt: number): number => Math.min(60_000, 1000 * 2 ** Math.min(attempt - 1, 10));

/**
 * Durable, ordered, at-least-once delivery of outbox messages (card S03). A message exists exactly when the command that announced it
 * committed (the command wrote it in its own transaction), so there is no message for a rolled-back change and none can be lost between
 * the change and the message. This class moves committed messages to a destination:
 *
 * 1. claim due messages (strictly in commit order per ordering key; a failing message holds back later ones of its key);
 * 2. call the handler; 3. record its receipt in one transaction with an audit record. Only after step 3 is a message delivered.
 *
 * A crash anywhere leaves the message claimed or pending: it is found again (when the claim's lease ends) and handed over again with the
 * same `deliveryId`, which is why a destination must deduplicate (card S04). Writes carry the controller's primary epoch, so a deposed
 * controller's dispatcher stops with `stale_epoch`. The receipt's operation ID is derived from the message, so recording it twice (an
 * ambiguous commit that is retried) is the same record.
 */
export class DeliveryDispatcher {
  readonly #storage: ControllerStorage;
  readonly #epoch: number;
  readonly #options: DispatcherOptions;
  readonly #clock: () => string;

  constructor(storage: ControllerStorage, epoch: number, options: DispatcherOptions) {
    if (!Number.isSafeInteger(epoch) || epoch < 1) throw new DomainError("invalid_command", "epoch: must be a whole number of at least 1", { field: "epoch" });
    this.#storage = storage;
    this.#epoch = epoch;
    this.#options = options;
    this.#clock = options.clock ?? (() => new Date().toISOString());
  }

  /** One pass: claim, hand over, record receipts. Safe to call from several dispatchers at once; a message goes to one holder at a time. */
  async runOnce(): Promise<PassResult> {
    let claims: DeliveryClaim[];
    try {
      claims = await this.#storage.claimDeliveries({ epoch: this.#epoch, destination: this.#options.destination, claimant: this.#options.claimant, now: this.#clock(), leaseMs: this.#options.leaseMs ?? 60_000, limit: this.#options.batch ?? 10 });
    } catch (error) { throw mapStorageError(error); }
    let delivered = 0, failed = 0, superseded = 0, held = 0;
    // One key's messages are claimed one at a time (storage never hands out two of one key), so claims here are independent.
    for (const claim of claims) {
      const outcome = await this.#deliver(claim);
      if (outcome === "delivered") delivered++; else if (outcome === "failed") failed++; else if (outcome === "held") held++; else superseded++;
    }
    return { delivered, failed, superseded, held };
  }

  async #deliver(claim: DeliveryClaim): Promise<"delivered" | "failed" | "superseded" | "held"> {
    if (this.#options.isHeld !== undefined && await this.#options.isHeld(claim)) {
      return (await this.#giveBack(claim, "held", this.#options.holdBackoffMs ?? 5 * 60_000)) === "superseded" ? "superseded" : "held";
    }
    let receipt: JsonObject;
    try {
      const result = await this.#options.handler({ deliveryId: claim.deliveryId, ...(claim.orderingKey === undefined ? {} : { orderingKey: claim.orderingKey }), aggregate: claim.aggregate, aggregateRevision: claim.aggregateRevision, payload: claim.payload, attempt: claim.attempt });
      receipt = { result: result ?? {}, attempt: claim.attempt };
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      let verdict: "retry" | "hold" = "retry";
      try { verdict = (await this.#options.onFailure?.(claim, reason)) ?? "retry"; } catch (hookError) { if (hookError instanceof DomainError && hookError.code === "stale_epoch") throw hookError; }
      return verdict === "hold" ? this.#giveBack(claim, reason, this.#options.holdBackoffMs ?? 5 * 60_000) : this.#giveBack(claim, reason);
    }
    const at = this.#clock();
    const input: OperationInput = {
      operationId: `rcpt:${claim.deliveryId}`, epoch: this.#epoch, actor: this.#options.claimant, correlationId: `rcpt:${claim.deliveryId}`, at,
      changes: [], audit: [{ type: "delivery.receipt", subject: claim.aggregate, detail: { deliveryId: claim.deliveryId, destination: claim.destination, attempt: claim.attempt } }],
      outbox: [], effects: [], timers: [], cancelTimers: [], completeDeliveries: [{ deliveryId: claim.deliveryId, claimToken: claim.claimToken, receipt }], completeTimers: [], settleEffects: [],
    };
    try {
      await commitOperation(this.#storage, input, { attempts: this.#options.attempts ?? 5, pause: this.#options.pause ?? ((n) => sleep(Math.min(200, 10 * 2 ** n))) });
      return "delivered";
    } catch (error) {
      // Another holder already recorded this message's receipt (the same operation ID with a different attempt) or took the claim.
      if (isStorageError(error, "state_conflict") || isStorageError(error, "not_found") || isStorageError(error, "idempotency_conflict")) return "superseded";
      if (isStorageError(error, "stale_epoch")) throw mapStorageError(error);
      // The receipt could not be recorded (storage unavailable): the destination has the message but the controller does not know. The claim is
      // left to expire so the message is handed over again with the same ID, which the destination deduplicates.
      return "failed";
    }
  }

  async #giveBack(claim: DeliveryClaim, reason: string, backoffOverride?: number): Promise<"failed" | "superseded"> {
    const now = this.#clock();
    const backoff = backoffOverride ?? (this.#options.backoffMs ?? defaultBackoff)(claim.attempt);
    try {
      await this.#storage.retryDelivery({ epoch: this.#epoch, deliveryId: claim.deliveryId, claimToken: claim.claimToken, nextAttemptAt: new Date(Date.parse(now) + backoff).toISOString(), reason: reason.slice(0, 500), at: now });
      return "failed";
    } catch (error) {
      if (isStorageError(error, "state_conflict") || isStorageError(error, "not_found")) return "superseded";
      if (isStorageError(error, "stale_epoch")) throw mapStorageError(error);
      return "failed";
    }
  }
}
