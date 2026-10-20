/**
 * The typed storage contract of the controller (card F04a). Domain services call these operations and nothing else: no
 * SQL, no connection, no transaction handle is ever exposed, so SQLite and PostgreSQL adapters (and any later one that
 * passes the conformance suite) are interchangeable.
 *
 * Representation rules every adapter must honour:
 * - **Identifiers** are ASCII strings matching `ID_PATTERN`; they sort by code point (adapters must use binary collation, see below).
 * - **Timestamps** are UTC ISO-8601 strings with milliseconds and a trailing `Z` (`2026-10-19T12:00:00.000Z`); string order
 *   is chronological order. Timestamps assist diagnosis. Revisions, sequence numbers and epochs decide correctness.
 * - **Integers** are non-negative safe integers (at most 2^53 - 1), so they survive JSON and any database integer column.
 * - **Bodies** are JSON objects stored as canonical JSON text (keys in code-point order, no insignificant whitespace). They
 *   round-trip exactly except for key order. `undefined` is not a value: an absent optional field is omitted, never `null`.
 *   `null` inside a body is an ordinary JSON value.
 * - **Reads return copies.** Changing a returned value never changes stored state.
 *
 * Transaction rules: every method below is exactly one atomic transaction on one connection; it either commits everything
 * it describes or nothing. Methods never call out (no model calls, no remote effects) while a transaction is open.
 *
 * Fencing: every method that writes takes the caller's primary epoch and refuses a stale one with `stale_epoch`, writing
 * nothing, so a deposed controller cannot claim, retry, complete or settle anything after a takeover. The one deliberate
 * exception is a repeat of an operation that already committed: it is answered with its stored result whatever the epoch,
 * because answering writes nothing. Lease expiry compares against a caller-supplied `now`; clocks may differ, which at worst
 * redelivers a message (receivers deduplicate by `deliveryId`), and the epoch, not the clock, is what keeps an old
 * controller out.
 *
 * Rules every adapter must follow so that behaviour does not depend on the database:
 * - **Sequence numbers** (`AuditRecord.seq`, `DeliveryRecord.seq`) are assigned from a counter row that the operation's own
 *   transaction updates, so the number is held until commit and numbers are assigned in commit order with no gaps. Never use
 *   a database sequence, `bigserial`, `AUTOINCREMENT` or `nextval`: those allocate in statement order and leave gaps on
 *   rollback, which would let a later message of an ordering key become claimable before an earlier one is visible. The cost
 *   is that every operation that writes audit or outbox rows serialises on that one row; F04d measures it.
 * - **Bodies are stored as text** (or PostgreSQL `json`, never `jsonb`) holding the canonical JSON, so the text and the request
 *   hash round-trip byte for byte. `jsonb` rewrites key order and numbers.
 * - **Identifiers and kinds compare in binary order** (SQLite `BINARY`, PostgreSQL `COLLATE "C"`), because they are ASCII and
 *   the contract sorts by code point; a locale collation orders `B1` after `a1`.
 * - **Races on unique keys are mapped, never leaked.** Two first submissions of one `operationId` that collide on the
 *   operation key surface as `retryable` from the loser (the retry then replays the winner's result). A delivery, effect or
 *   timer ID taken by another operation first is `duplicate_id` after a re-check. Driver errors are never returned raw.
 */

export type Json = null | boolean | number | string | readonly Json[] | { readonly [key: string]: Json };
export type JsonObject = { readonly [key: string]: Json };

export type Id = string;
export type Timestamp = string;

export const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/;
export const KIND_PATTERN = /^[a-z][a-z0-9-]{0,39}$/;
export const TIMESTAMP_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

/** Limits that keep every transaction short and every body small. */
export const LIMITS = {
  /** Entries of each kind (changes, audit, outbox, effects, timers) in one operation. */
  perOperation: 100,
  bodyBytes: 256 * 1024,
  bodyDepth: 32,
  claimLimit: 100,
  pageLimit: 1000,
  leaseMs: 24 * 60 * 60 * 1000,
} as const;

export interface AggregateRef {
  /** For example `task`, `project`, `assignment`. Lower-case words joined by hyphens. */
  readonly kind: string;
  readonly id: Id;
}

export interface Aggregate extends AggregateRef {
  /** Starts at 1 on creation and increases by exactly 1 with every update. */
  readonly revision: number;
  readonly body: JsonObject;
  readonly createdAt: Timestamp;
  readonly updatedAt: Timestamp;
}

/** What one operation does to one aggregate. Revision checks make concurrent writers safe without locks in the domain. */
export type Change =
  /** The aggregate must not exist. It is created at revision 1. */
  | { readonly type: "create"; readonly ref: AggregateRef; readonly body: JsonObject }
  /** The aggregate must be at `expectedRevision`. Its body is replaced and the revision becomes `expectedRevision + 1`. */
  | { readonly type: "update"; readonly ref: AggregateRef; readonly expectedRevision: number; readonly body: JsonObject }
  /** The aggregate must be at `expectedRevision`; nothing is written. A guard, for example against a parent that moved. */
  | { readonly type: "check"; readonly ref: AggregateRef; readonly expectedRevision: number };

export interface AuditEntry {
  /** What happened, for example `task.assigned`. */
  readonly type: string;
  readonly subject?: AggregateRef;
  readonly detail: JsonObject;
}

export interface OutboxEntry {
  /** Stable message identity, unique across all operations. */
  readonly deliveryId: Id;
  readonly destination: string;
  /** Deliveries to one destination that share an ordering key are delivered strictly in commit order (for example a task ID). */
  readonly orderingKey?: string;
  /** 0 to 9. Higher is claimed first among deliveries that are free to go. */
  readonly priority: number;
  /** The aggregate this message announces. It must be among the operation's changes; its resulting revision is recorded. */
  readonly aggregate: AggregateRef;
  readonly payload: JsonObject;
  /** Not claimable before this time. */
  readonly notBefore?: Timestamp;
}

export interface EffectEntry {
  readonly effectId: Id;
  readonly attemptId?: Id;
  /** The exact target of the external effect, for example a repository and ref. */
  readonly target: string;
  /** SHA-256 hex digest of the exact input of the effect. */
  readonly inputDigest: string;
  /** Handle for external idempotency or later reconciliation. */
  readonly reconciliationHandle?: string;
}

export interface TimerEntry {
  readonly timerId: Id;
  readonly dueAt: Timestamp;
  readonly aggregate?: AggregateRef;
  readonly payload: JsonObject;
}

/**
 * Everything one command changes, committed together or not at all: aggregate changes, the audit trail, outbox messages,
 * effect intentions and timers. `operationId` is the idempotency key.
 */
export interface OperationInput {
  readonly operationId: Id;
  /** The primary epoch the caller believes is current. A stale epoch is rejected and nothing is written. */
  readonly epoch: number;
  readonly actor: string;
  readonly correlationId: Id;
  /** When the caller issued the command. Recorded, never compared; excluded from the request hash. */
  readonly at: Timestamp;
  readonly changes: readonly Change[];
  readonly audit: readonly AuditEntry[];
  readonly outbox: readonly OutboxEntry[];
  readonly effects: readonly EffectEntry[];
  readonly timers: readonly TimerEntry[];
  /** Timers to cancel. Cancelling one that does not exist or has fired is not an error. A cancelled timer that is currently claimed makes its holder's later completion fail with `state_conflict`: cancellation wins, and the holder treats that as "superseded". */
  readonly cancelTimers: readonly Id[];
  /**
   * Reconciliation, committed in the same transaction as the domain transition it belongs to (a handler that records a
   * receipt and moves a task does both or neither). Records the durable receipt of a claimed delivery. The claim token must be
   * the current one (`state_conflict` otherwise); a late completion by the current holder is accepted if nobody took over; a
   * delivery that is already delivered with the same receipt is a no-op for any token, a different receipt is `state_conflict`.
   */
  readonly completeDeliveries: readonly { readonly deliveryId: Id; readonly claimToken: string; readonly receipt: JsonObject }[];
  /** Marks claimed timers fired. Same token rules as deliveries; completing an already completed timer with its token is a no-op. */
  readonly completeTimers: readonly { readonly timerId: Id; readonly claimToken: string }[];
  /**
   * Moves effects forward: `intended -> uncertain -> confirmed | failed`, or `intended -> confirmed | failed`. Repeating the
   * current outcome is a no-op. Confirmed and failed are final; contradicting them is `state_conflict`. Every settlement
   * writes an `effect.settled` audit record automatically (subject: kind `effect`), after the operation's own audit entries.
   */
  readonly settleEffects: readonly { readonly effectId: Id; readonly outcome: "uncertain" | "confirmed" | "failed"; readonly evidence?: JsonObject }[];
}

export interface OperationResult {
  readonly operationId: Id;
  /** True when this call returned the outcome of an earlier identical admission instead of doing the work again. */
  readonly replayed: boolean;
  /** Revision of each `create`, `update` and `check` after the operation, in the order given. */
  readonly revisions: readonly { readonly ref: AggregateRef; readonly revision: number }[];
  /** Sequence numbers of the audit entries written, in order. Empty if the operation wrote none. */
  readonly auditSeqs: readonly number[];
  readonly epoch: number;
}

/** What storage remembers about an admitted operation. `requestHash` is `operationHash(input)`. */
export interface StoredOperation {
  readonly operationId: Id;
  readonly requestHash: string;
  readonly actor: string;
  readonly correlationId: Id;
  readonly at: Timestamp;
  readonly result: OperationResult;
}

export interface AuditRecord {
  /** Strictly increasing and gap-free across the installation. */
  readonly seq: number;
  readonly operationId: Id;
  readonly correlationId: Id;
  readonly actor: string;
  readonly at: Timestamp;
  readonly type: string;
  readonly subject?: AggregateRef;
  readonly detail: JsonObject;
}

export type DeliveryState = "pending" | "claimed" | "delivered";

export interface DeliveryRecord {
  readonly deliveryId: Id;
  /** Commit order across the installation; defines ordering within an ordering key. */
  readonly seq: number;
  readonly destination: string;
  readonly orderingKey?: string;
  readonly priority: number;
  readonly aggregate: AggregateRef;
  readonly aggregateRevision: number;
  readonly payload: JsonObject;
  readonly state: DeliveryState;
  /** Claims so far, including a current one. */
  readonly attempts: number;
  /** Earliest time the delivery may next be claimed. */
  readonly nextAttemptAt: Timestamp;
  /** For a claimed delivery: when the lease ends and another claimant may take it. */
  readonly claimedUntil?: Timestamp;
  readonly lastError?: string;
  /** The durable receipt, once delivered. */
  readonly receipt?: JsonObject;
  readonly deliveredAt?: Timestamp;
}

export interface DeliveryClaim {
  readonly deliveryId: Id;
  /** Opaque. Only the holder of the current token may complete or retry the delivery. */
  readonly claimToken: string;
  readonly attempt: number;
  readonly destination: string;
  readonly orderingKey?: string;
  readonly priority: number;
  readonly aggregate: AggregateRef;
  readonly aggregateRevision: number;
  readonly payload: JsonObject;
  readonly claimedUntil: Timestamp;
}

export type EffectStatus = "intended" | "uncertain" | "confirmed" | "failed";

export interface EffectRecord extends EffectEntry {
  readonly operationId: Id;
  readonly status: EffectStatus;
  readonly evidence?: JsonObject;
  readonly createdAt: Timestamp;
  readonly updatedAt: Timestamp;
}

export interface TimerRecord extends TimerEntry {
  readonly state: "pending" | "claimed" | "completed" | "cancelled";
  readonly attempts: number;
  readonly claimedUntil?: Timestamp;
}

export interface TimerClaim {
  readonly timerId: Id;
  readonly claimToken: string;
  readonly attempt: number;
  readonly dueAt: Timestamp;
  readonly aggregate?: AggregateRef;
  readonly payload: JsonObject;
  readonly claimedUntil: Timestamp;
}

export interface Page {
  readonly afterId?: Id;
  readonly limit: number;
}

export interface ControllerStorage {
  // ---- epochs: which controller instance may write -------------------------------------------------------------
  /** The current primary epoch. 0 means no controller has taken ownership yet; no operation can be admitted at 0. */
  currentEpoch(): Promise<number>;
  /**
   * Takes ownership: sets the epoch to the current one plus 1 and records the holder. With `expectedEpoch`, it succeeds only
   * if the current epoch equals it (compare-and-set takeover); otherwise `stale_epoch`.
   */
  acquireEpoch(input: { holder: string; at: Timestamp; expectedEpoch?: number }): Promise<{ epoch: number }>;

  // ---- the one write primitive ---------------------------------------------------------------------------------
  /**
   * Admits a command and applies everything it describes in one transaction. Checks, in this order: input validity;
   * existing operation (same hash: return its stored result with `replayed: true`; different hash: `idempotency_conflict`);
   * epoch (`stale_epoch`); then each change's revision (`revision_conflict`, `not_found`) and the uniqueness of every
   * delivery, effect and timer ID (`duplicate_id`). If any check fails nothing is written, including the operation record.
   */
  applyOperation(input: OperationInput): Promise<OperationResult>;
  /** Looks an operation up by its stable ID. This is how an uncertain commit is resolved: present means it committed. */
  getOperation(operationId: Id): Promise<StoredOperation | undefined>;

  // ---- reads ---------------------------------------------------------------------------------------------------
  getAggregate(ref: AggregateRef): Promise<Aggregate | undefined>;
  /** Aggregates of one kind in ID order after `afterId`. */
  listAggregates(kind: string, page: Page): Promise<Aggregate[]>;
  /** Audit records with `seq` greater than `afterSeq`, in order. */
  listAudit(input: { afterSeq: number; limit: number }): Promise<AuditRecord[]>;

  // ---- delivery (outbox) ---------------------------------------------------------------------------------------
  /**
   * Claims up to `limit` deliveries for `destination` that are free to go: pending (or claimed with an expired lease), due
   * (`nextAttemptAt <= now`), and with no earlier undelivered delivery of the same destination and ordering key. Highest
   * priority first, then commit order. Two concurrent claimants never receive the same delivery, and never two deliveries of
   * one ordering key. Claiming an expired lease issues a new token; the old token no longer works.
   */
  claimDeliveries(input: { epoch: number; destination: string; claimant: string; now: Timestamp; leaseMs: number; limit: number }): Promise<DeliveryClaim[]>;
  /**
   * Gives the claim back for a later attempt at `nextAttemptAt`; later deliveries of the same ordering key keep waiting.
   * (Receipts are recorded through `applyOperation`'s `completeDeliveries`.)
   */
  retryDelivery(input: { epoch: number; deliveryId: Id; claimToken: string; nextAttemptAt: Timestamp; reason: string; at: Timestamp }): Promise<void>;
  getDelivery(deliveryId: Id): Promise<DeliveryRecord | undefined>;

  // ---- external effects (settled through `applyOperation`'s `settleEffects`) ------------------------------------
  getEffect(effectId: Id): Promise<EffectRecord | undefined>;

  // ---- timers --------------------------------------------------------------------------------------------------
  /** Claims up to `limit` timers due at or before `now` (pending, or claimed with an expired lease), earliest first. Fired through `applyOperation`'s `completeTimers`. */
  claimDueTimers(input: { epoch: number; claimant: string; now: Timestamp; leaseMs: number; limit: number }): Promise<TimerClaim[]>;
  getTimer(timerId: Id): Promise<TimerRecord | undefined>;

  close(): Promise<void>;
}
