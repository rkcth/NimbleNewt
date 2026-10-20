import { StorageError } from "./errors.js";
import { operationHash } from "./hash.js";
import { canonicalJson, compareCodePoints, parseJson } from "./json.js";
import {
  checkBody, checkCount, checkId, checkKind, checkLease, checkPage, checkRef, checkText, checkTimestamp, validateOperation,
} from "./validate.js";
import type {
  Aggregate, AggregateRef, AuditRecord, ControllerStorage, DeliveryClaim, DeliveryRecord, EffectRecord, EffectStatus, Id, JsonObject, OperationInput,
  OperationResult, Page, StoredOperation, TimerClaim, TimerRecord, Timestamp,
} from "./types.js";

interface AggregateRow { kind: string; id: string; revision: number; body: string; createdAt: Timestamp; updatedAt: Timestamp }
interface OperationRow { hash: string; actor: string; correlationId: string; at: Timestamp; result: string }
interface AuditRow { seq: number; operationId: string; correlationId: string; actor: string; at: Timestamp; type: string; subject?: AggregateRef; detail: string }
interface DeliveryRow {
  deliveryId: string; seq: number; destination: string; orderingKey?: string; priority: number; aggregate: AggregateRef; aggregateRevision: number; payload: string;
  state: "pending" | "claimed" | "delivered"; attempts: number; nextAttemptAt: Timestamp; claimedUntil?: Timestamp; token?: string; lastError?: string; receipt?: string; deliveredAt?: Timestamp;
}
interface EffectRow { effectId: string; operationId: string; attemptId?: string; target: string; inputDigest: string; reconciliationHandle?: string; status: EffectStatus; evidence?: string; createdAt: Timestamp; updatedAt: Timestamp }
interface TimerRow { timerId: string; dueAt: Timestamp; aggregate?: AggregateRef; payload: string; state: "pending" | "claimed" | "completed" | "cancelled"; attempts: number; claimedUntil?: Timestamp; token?: string }

const key = (ref: AggregateRef): string => `${ref.kind}/${ref.id}`;
const optional = <K extends string, V>(name: K, value: V | undefined): { [P in K]?: V } => (value === undefined ? {} : ({ [name]: value } as { [P in K]?: V }));
const plus = (at: Timestamp, ms: number): Timestamp => new Date(Date.parse(at) + ms).toISOString();

/**
 * The reference implementation of `ControllerStorage`, held in memory. It defines the behaviour the SQLite and PostgreSQL
 * adapters must reproduce (they are checked against the same conformance suite) and is what the rest of the controller is
 * tested against. It is not durable. Each method runs to completion without yielding, which is what makes it atomic.
 */
export class MemoryStorage implements ControllerStorage {
  #closed = false;
  #epoch = 0;
  #holder: string | undefined;
  readonly #aggregates = new Map<string, AggregateRow>();
  readonly #operations = new Map<string, OperationRow>();
  readonly #audit: AuditRow[] = [];
  readonly #deliveries = new Map<string, DeliveryRow>();
  #deliverySeq = 0;
  readonly #effects = new Map<string, EffectRow>();
  readonly #timers = new Map<string, TimerRow>();

  #open(): void {
    if (this.#closed) throw new StorageError("unavailable", "the storage is closed");
  }

  #fence(epoch: unknown): void {
    checkCount(epoch, "epoch", Number.MAX_SAFE_INTEGER, 1);
    if (epoch !== this.#epoch) throw new StorageError("stale_epoch", `call is for epoch ${epoch} but the current epoch is ${this.#epoch}`);
  }

  async currentEpoch(): Promise<number> {
    this.#open();
    return this.#epoch;
  }

  async acquireEpoch(input: { holder: string; at: Timestamp; expectedEpoch?: number }): Promise<{ epoch: number }> {
    this.#open();
    checkText(input.holder, "holder");
    checkTimestamp(input.at, "at");
    if (input.expectedEpoch !== undefined) checkCount(input.expectedEpoch, "expectedEpoch");
    if (input.expectedEpoch !== undefined && input.expectedEpoch !== this.#epoch) {
      throw new StorageError("stale_epoch", `expected epoch ${input.expectedEpoch} but the current epoch is ${this.#epoch}`);
    }
    this.#epoch += 1;
    this.#holder = input.holder;
    return { epoch: this.#epoch };
  }

  async applyOperation(input: OperationInput): Promise<OperationResult> {
    this.#open();
    validateOperation(input);
    const hash = operationHash(input);

    const existing = this.#operations.get(input.operationId);
    if (existing !== undefined) {
      if (existing.hash !== hash) throw new StorageError("idempotency_conflict", `operation ${input.operationId} was already used with different content`);
      return { ...(parseJson(existing.result) as unknown as OperationResult), replayed: true };
    }
    if (input.epoch !== this.#epoch) throw new StorageError("stale_epoch", `operation is for epoch ${input.epoch} but the current epoch is ${this.#epoch}`);

    // Check everything before writing anything, so a failure leaves no trace.
    const revisions: { ref: AggregateRef; revision: number }[] = [];
    for (const [i, change] of input.changes.entries()) {
      const current = this.#aggregates.get(key(change.ref));
      if (change.type === "create") {
        if (current !== undefined) throw new StorageError("revision_conflict", `${key(change.ref)} already exists (changes[${i}])`);
        revisions.push({ ref: change.ref, revision: 1 });
      } else {
        if (current === undefined) throw new StorageError("not_found", `${key(change.ref)} does not exist (changes[${i}])`);
        if (current.revision !== change.expectedRevision) {
          throw new StorageError("revision_conflict", `${key(change.ref)} is at revision ${current.revision}, expected ${change.expectedRevision} (changes[${i}])`);
        }
        revisions.push({ ref: change.ref, revision: change.type === "update" ? change.expectedRevision + 1 : change.expectedRevision });
      }
    }
    for (const c of input.completeDeliveries) {
      const d = this.#deliveries.get(c.deliveryId);
      if (d === undefined) throw new StorageError("not_found", `delivery ${c.deliveryId} does not exist`);
      if (d.state === "delivered") {
        if (d.receipt !== canonicalJson(c.receipt)) throw new StorageError("state_conflict", `delivery ${c.deliveryId} was already delivered with a different receipt`);
      } else if (d.state !== "claimed" || d.token !== c.claimToken) throw new StorageError("state_conflict", `delivery ${c.deliveryId} is not held by this claim`);
    }
    for (const c of input.completeTimers) {
      const t = this.#timers.get(c.timerId);
      if (t === undefined) throw new StorageError("not_found", `timer ${c.timerId} does not exist`);
      const repeat = t.state === "completed" && t.token === c.claimToken;
      if (!repeat && (t.state !== "claimed" || t.token !== c.claimToken)) throw new StorageError("state_conflict", `timer ${c.timerId} is not held by this claim`);
    }
    for (const c of input.settleEffects) {
      const e = this.#effects.get(c.effectId);
      if (e === undefined) throw new StorageError("not_found", `effect ${c.effectId} does not exist`);
      if (e.status !== c.outcome && (e.status === "confirmed" || e.status === "failed")) throw new StorageError("state_conflict", `effect ${c.effectId} is already ${e.status}`);
    }
    for (const o of input.outbox) if (this.#deliveries.has(o.deliveryId)) throw new StorageError("duplicate_id", `delivery ${o.deliveryId} already exists`);
    for (const e of input.effects) if (this.#effects.has(e.effectId)) throw new StorageError("duplicate_id", `effect ${e.effectId} already exists`);
    for (const t of input.timers) if (this.#timers.has(t.timerId)) throw new StorageError("duplicate_id", `timer ${t.timerId} already exists`);

    for (const [i, change] of input.changes.entries()) {
      if (change.type === "check") continue;
      const body = canonicalJson(change.body);
      const old = this.#aggregates.get(key(change.ref));
      this.#aggregates.set(key(change.ref), { kind: change.ref.kind, id: change.ref.id, revision: revisions[i]!.revision, body, createdAt: old?.createdAt ?? input.at, updatedAt: input.at });
    }
    const auditSeqs: number[] = [];
    for (const a of input.audit) {
      const seq = this.#audit.length + 1;
      auditSeqs.push(seq);
      this.#audit.push({ seq, operationId: input.operationId, correlationId: input.correlationId, actor: input.actor, at: input.at, type: a.type, ...optional("subject", a.subject), detail: canonicalJson(a.detail) });
    }
    for (const c of input.settleEffects) {
      const e = this.#effects.get(c.effectId)!;
      const seq = this.#audit.length + 1;
      auditSeqs.push(seq);
      this.#audit.push({ seq, operationId: input.operationId, correlationId: input.correlationId, actor: input.actor, at: input.at, type: "effect.settled", subject: { kind: "effect", id: c.effectId }, detail: canonicalJson({ outcome: c.outcome, previous: e.status }) });
      if (e.status !== c.outcome) {
        e.status = c.outcome;
        e.updatedAt = input.at;
        if (c.evidence !== undefined) e.evidence = canonicalJson(c.evidence);
      }
    }
    for (const c of input.completeDeliveries) {
      const d = this.#deliveries.get(c.deliveryId)!;
      if (d.state === "delivered") continue;
      d.state = "delivered";
      d.receipt = canonicalJson(c.receipt);
      d.deliveredAt = input.at;
      delete d.claimedUntil;
    }
    for (const c of input.completeTimers) {
      const t = this.#timers.get(c.timerId)!;
      if (t.state === "completed") continue;
      t.state = "completed";
      delete t.claimedUntil;
    }
    for (const o of input.outbox) {
      const revision = revisions.find((r) => key(r.ref) === key(o.aggregate))!.revision;
      this.#deliverySeq += 1;
      this.#deliveries.set(o.deliveryId, {
        deliveryId: o.deliveryId, seq: this.#deliverySeq, destination: o.destination, ...optional("orderingKey", o.orderingKey), priority: o.priority,
        aggregate: o.aggregate, aggregateRevision: revision, payload: canonicalJson(o.payload), state: "pending", attempts: 0, nextAttemptAt: o.notBefore ?? input.at,
      });
    }
    for (const e of input.effects) {
      this.#effects.set(e.effectId, { effectId: e.effectId, operationId: input.operationId, ...optional("attemptId", e.attemptId), target: e.target, inputDigest: e.inputDigest, ...optional("reconciliationHandle", e.reconciliationHandle), status: "intended", createdAt: input.at, updatedAt: input.at });
    }
    for (const t of input.timers) {
      this.#timers.set(t.timerId, { timerId: t.timerId, dueAt: t.dueAt, ...optional("aggregate", t.aggregate), payload: canonicalJson(t.payload), state: "pending", attempts: 0 });
    }
    for (const id of input.cancelTimers) {
      const timer = this.#timers.get(id);
      if (timer !== undefined && (timer.state === "pending" || timer.state === "claimed")) timer.state = "cancelled";
    }

    const result: OperationResult = { operationId: input.operationId, replayed: false, revisions, auditSeqs, epoch: input.epoch };
    this.#operations.set(input.operationId, { hash, actor: input.actor, correlationId: input.correlationId, at: input.at, result: canonicalJson(result) });
    return result;
  }

  async getOperation(operationId: Id): Promise<StoredOperation | undefined> {
    this.#open();
    checkId(operationId, "operationId");
    const row = this.#operations.get(operationId);
    if (row === undefined) return undefined;
    return { operationId, requestHash: row.hash, actor: row.actor, correlationId: row.correlationId, at: row.at, result: parseJson(row.result) as unknown as OperationResult };
  }

  async getAggregate(ref: AggregateRef): Promise<Aggregate | undefined> {
    this.#open();
    checkRef(ref, "ref");
    const row = this.#aggregates.get(key(ref));
    return row === undefined ? undefined : this.#aggregate(row);
  }

  async listAggregates(kind: string, page: Page): Promise<Aggregate[]> {
    this.#open();
    checkKind(kind, "kind");
    checkPage(page);
    return [...this.#aggregates.values()]
      .filter((row) => row.kind === kind && (page.afterId === undefined || compareCodePoints(row.id, page.afterId) > 0))
      .sort((a, b) => compareCodePoints(a.id, b.id))
      .slice(0, page.limit)
      .map((row) => this.#aggregate(row));
  }

  async listAudit(input: { afterSeq: number; limit: number }): Promise<AuditRecord[]> {
    this.#open();
    checkCount(input.afterSeq, "afterSeq");
    checkCount(input.limit, "limit", 1000, 1);
    return this.#audit.filter((a) => a.seq > input.afterSeq).slice(0, input.limit).map((a) => ({
      seq: a.seq, operationId: a.operationId, correlationId: a.correlationId, actor: a.actor, at: a.at, type: a.type, ...optional("subject", a.subject === undefined ? undefined : { ...a.subject }), detail: parseJson(a.detail) as JsonObject,
    }));
  }

  async claimDeliveries(input: { epoch: number; destination: string; claimant: string; now: Timestamp; leaseMs: number; limit: number }): Promise<DeliveryClaim[]> {
    this.#open();
    this.#fence(input.epoch);
    checkText(input.destination, "destination");
    checkText(input.claimant, "claimant");
    checkTimestamp(input.now, "now");
    checkLease(input.leaseMs, input.limit, "claim");
    const mine = [...this.#deliveries.values()].filter((d) => d.destination === input.destination).sort((a, b) => a.seq - b.seq);
    const heads = new Map<string, DeliveryRow>();
    for (const d of mine) if (d.state !== "delivered" && d.orderingKey !== undefined && !heads.has(d.orderingKey)) heads.set(d.orderingKey, d);
    const free = (d: DeliveryRow): boolean =>
      d.state !== "delivered" && (d.state === "pending" || (d.claimedUntil ?? "") <= input.now) && d.nextAttemptAt <= input.now && (d.orderingKey === undefined || heads.get(d.orderingKey) === d);
    const chosen = mine.filter(free).sort((a, b) => b.priority - a.priority || a.seq - b.seq).slice(0, input.limit);
    return chosen.map((d) => {
      d.state = "claimed";
      d.attempts += 1;
      d.claimedUntil = plus(input.now, input.leaseMs);
      d.token = `${d.deliveryId}#${d.attempts}`;
      return {
        deliveryId: d.deliveryId, claimToken: d.token, attempt: d.attempts, destination: d.destination, ...optional("orderingKey", d.orderingKey), priority: d.priority,
        aggregate: { ...d.aggregate }, aggregateRevision: d.aggregateRevision, payload: parseJson(d.payload) as JsonObject, claimedUntil: d.claimedUntil,
      };
    });
  }

  async retryDelivery(input: { epoch: number; deliveryId: Id; claimToken: string; nextAttemptAt: Timestamp; reason: string; at: Timestamp }): Promise<void> {
    this.#open();
    this.#fence(input.epoch);
    checkId(input.deliveryId, "deliveryId");
    checkText(input.claimToken, "claimToken");
    checkTimestamp(input.nextAttemptAt, "nextAttemptAt");
    checkText(input.reason, "reason");
    checkTimestamp(input.at, "at");
    const d = this.#deliveries.get(input.deliveryId);
    if (d === undefined) throw new StorageError("not_found", `delivery ${input.deliveryId} does not exist`);
    if (d.state !== "claimed" || d.token !== input.claimToken) throw new StorageError("state_conflict", `delivery ${input.deliveryId} is not held by this claim`);
    d.state = "pending";
    d.nextAttemptAt = input.nextAttemptAt;
    d.lastError = input.reason;
    delete d.claimedUntil;
  }

  async getDelivery(deliveryId: Id): Promise<DeliveryRecord | undefined> {
    this.#open();
    checkId(deliveryId, "deliveryId");
    const d = this.#deliveries.get(deliveryId);
    if (d === undefined) return undefined;
    return {
      deliveryId: d.deliveryId, seq: d.seq, destination: d.destination, ...optional("orderingKey", d.orderingKey), priority: d.priority, aggregate: { ...d.aggregate },
      aggregateRevision: d.aggregateRevision, payload: parseJson(d.payload) as JsonObject, state: d.state, attempts: d.attempts, nextAttemptAt: d.nextAttemptAt,
      ...optional("claimedUntil", d.claimedUntil), ...optional("lastError", d.lastError), ...optional("receipt", d.receipt === undefined ? undefined : (parseJson(d.receipt) as JsonObject)), ...optional("deliveredAt", d.deliveredAt),
    };
  }

  async getEffect(effectId: Id): Promise<EffectRecord | undefined> {
    this.#open();
    checkId(effectId, "effectId");
    const e = this.#effects.get(effectId);
    return e === undefined ? undefined : this.#effect(e);
  }

  async claimDueTimers(input: { epoch: number; claimant: string; now: Timestamp; leaseMs: number; limit: number }): Promise<TimerClaim[]> {
    this.#open();
    this.#fence(input.epoch);
    checkText(input.claimant, "claimant");
    checkTimestamp(input.now, "now");
    checkLease(input.leaseMs, input.limit, "claim");
    const due = [...this.#timers.values()]
      .filter((t) => (t.state === "pending" || (t.state === "claimed" && (t.claimedUntil ?? "") <= input.now)) && t.dueAt <= input.now)
      .sort((a, b) => compareCodePoints(a.dueAt, b.dueAt) || compareCodePoints(a.timerId, b.timerId))
      .slice(0, input.limit);
    return due.map((t) => {
      t.state = "claimed";
      t.attempts += 1;
      t.claimedUntil = plus(input.now, input.leaseMs);
      t.token = `${t.timerId}#${t.attempts}`;
      return { timerId: t.timerId, claimToken: t.token, attempt: t.attempts, dueAt: t.dueAt, ...optional("aggregate", t.aggregate), payload: parseJson(t.payload) as JsonObject, claimedUntil: t.claimedUntil };
    });
  }

  async getTimer(timerId: Id): Promise<TimerRecord | undefined> {
    this.#open();
    checkId(timerId, "timerId");
    const t = this.#timers.get(timerId);
    if (t === undefined) return undefined;
    return { timerId: t.timerId, dueAt: t.dueAt, ...optional("aggregate", t.aggregate === undefined ? undefined : { ...t.aggregate }), payload: parseJson(t.payload) as JsonObject, state: t.state, attempts: t.attempts, ...optional("claimedUntil", t.claimedUntil) };
  }

  async close(): Promise<void> {
    this.#closed = true;
  }

  #aggregate(row: AggregateRow): Aggregate {
    return { kind: row.kind, id: row.id, revision: row.revision, body: parseJson(row.body) as JsonObject, createdAt: row.createdAt, updatedAt: row.updatedAt };
  }

  #effect(e: EffectRow): EffectRecord {
    return {
      effectId: e.effectId, operationId: e.operationId, ...optional("attemptId", e.attemptId), target: e.target, inputDigest: e.inputDigest, ...optional("reconciliationHandle", e.reconciliationHandle),
      status: e.status, ...optional("evidence", e.evidence === undefined ? undefined : (parseJson(e.evidence) as JsonObject)), createdAt: e.createdAt, updatedAt: e.updatedAt,
    };
  }
}
