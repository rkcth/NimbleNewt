import { StorageError } from "./errors.js";
import { canonicalJson } from "./json.js";
import { TOMBSTONE_KIND } from "./tombstone.js";
import {
  ID_PATTERN, KIND_PATTERN, LIMITS, TIMESTAMP_PATTERN,
  type AggregateRef, type JsonObject, type OperationInput, type Page, type Timestamp,
} from "./types.js";

const bad = (path: string, message: string): never => { throw new StorageError("invalid_input", `${path}: ${message}`, { path }); };

export function checkId(value: unknown, path: string): string {
  if (typeof value !== "string" || !ID_PATTERN.test(value)) return bad(path, "must be 1-200 ASCII letters, digits, '.', '_', ':' or '-', starting with a letter or digit");
  return value;
}
export function checkKind(value: unknown, path: string): string {
  if (typeof value !== "string" || !KIND_PATTERN.test(value)) return bad(path, "must be lower-case words joined by hyphens (at most 40 characters)");
  return value;
}
export function checkTimestamp(value: unknown, path: string): Timestamp {
  if (typeof value !== "string" || !TIMESTAMP_PATTERN.test(value)) return bad(path, "must be a UTC timestamp like 2026-10-19T12:00:00.000Z");
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime()) || parsed.toISOString() !== value) return bad(path, "is not a real calendar time");
  return value;
}
export function checkCount(value: unknown, path: string, max = Number.MAX_SAFE_INTEGER, min = 0): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < min || value > max) return bad(path, `must be a whole number from ${min} to ${max}`);
  return value;
}
export function checkText(value: unknown, path: string): string {
  if (typeof value !== "string" || value.length === 0 || value.length > 500 || /[\u0000-\u001f]/.test(value)) return bad(path, "must be 1-500 characters without control characters");
  return value;
}
export function checkBody(value: unknown, path: string): JsonObject {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return bad(path, "must be an object");
  const text = canonicalJson(value, path);
  if (Buffer.byteLength(text, "utf8") > LIMITS.bodyBytes) return bad(path, `is larger than ${LIMITS.bodyBytes} bytes`);
  return value as JsonObject;
}
export function checkRef(value: unknown, path: string): AggregateRef {
  if (value === null || typeof value !== "object") return bad(path, "must be { kind, id }");
  const ref = value as Record<string, unknown>;
  checkKind(ref.kind, `${path}.kind`);
  checkId(ref.id, `${path}.id`);
  return value as AggregateRef;
}
export function checkPage(page: Page, path = "page"): void {
  checkCount(page.limit, `${path}.limit`, LIMITS.pageLimit, 1);
  if (page.afterId !== undefined) checkId(page.afterId, `${path}.afterId`);
}
export function checkLease(leaseMs: unknown, limit: unknown, path: string): void {
  checkCount(leaseMs, `${path}.leaseMs`, LIMITS.leaseMs, 1);
  checkCount(limit, `${path}.limit`, LIMITS.claimLimit, 1);
}

const list = <T>(value: unknown, path: string): readonly T[] => {
  if (!Array.isArray(value)) return bad(path, "must be a list");
  if (value.length > LIMITS.perOperation) return bad(path, `has ${value.length} entries; at most ${LIMITS.perOperation} per operation`);
  return value as readonly T[];
};
const only = (value: object, allowed: readonly string[], path: string): void => {
  for (const key of Object.keys(value)) if (!allowed.includes(key)) bad(`${path}.${key}`, "is not a known field");
};
const refKey = (ref: AggregateRef) => `${ref.kind}/${ref.id}`;

/**
 * Checks everything about an operation that can be checked without looking at stored state, and throws `invalid_input` with
 * the path of the first problem. Every adapter calls this first, so malformed requests are refused identically everywhere.
 */
export function validateOperation(input: OperationInput): void {
  if (input === null || typeof input !== "object") bad("operation", "must be an object");
  only(input, ["operationId", "epoch", "actor", "correlationId", "at", "changes", "audit", "outbox", "effects", "timers", "cancelTimers", "completeDeliveries", "completeTimers", "settleEffects"], "operation");
  checkId(input.operationId, "operationId");
  checkCount(input.epoch, "epoch", Number.MAX_SAFE_INTEGER, 1);
  checkText(input.actor, "actor");
  checkId(input.correlationId, "correlationId");
  checkTimestamp(input.at, "at");

  const changed = new Set<string>();
  const deleted = new Set<string>();
  list<OperationInput["changes"][number]>(input.changes, "changes").forEach((c, i) => {
    const p = `changes[${i}]`;
    if (c === null || typeof c !== "object") return bad(p, "must be an object");
    checkRef(c.ref, `${p}.ref`);
    if (c.ref.kind === TOMBSTONE_KIND) bad(`${p}.ref.kind`, `${TOMBSTONE_KIND} is reserved for the records the storage keeps of removed aggregates`);
    if (changed.has(refKey(c.ref))) bad(`${p}.ref`, "the same aggregate appears twice in one operation");
    changed.add(refKey(c.ref));
    if (c.type === "create") { only(c, ["type", "ref", "body"], p); checkBody(c.body, `${p}.body`); }
    else if (c.type === "update") { only(c, ["type", "ref", "expectedRevision", "body"], p); checkCount(c.expectedRevision, `${p}.expectedRevision`, Number.MAX_SAFE_INTEGER - 1, 1); checkBody(c.body, `${p}.body`); }
    else if (c.type === "check") { only(c, ["type", "ref", "expectedRevision"], p); checkCount(c.expectedRevision, `${p}.expectedRevision`, Number.MAX_SAFE_INTEGER, 1); }
    else if (c.type === "delete") {
      only(c, ["type", "ref", "expectedRevision"], p); checkCount(c.expectedRevision, `${p}.expectedRevision`, Number.MAX_SAFE_INTEGER, 1);
      deleted.add(refKey(c.ref));
    }
    else bad(`${p}.type`, 'must be "create", "update", "check" or "delete"');
  });

  list<OperationInput["audit"][number]>(input.audit, "audit").forEach((a, i) => {
    const p = `audit[${i}]`;
    if (a === null || typeof a !== "object") return bad(p, "must be an object");
    only(a, ["type", "subject", "detail"], p);
    checkText(a.type, `${p}.type`);
    if (a.subject !== undefined) checkRef(a.subject, `${p}.subject`);
    checkBody(a.detail, `${p}.detail`);
  });

  for (const d of deleted) {
    if (!input.audit.some((a) => a !== null && typeof a === "object" && a.subject !== undefined && a.subject !== null && refKey(a.subject) === d)) bad("audit", `a removal of ${d} must carry an audit entry whose subject is that aggregate`);
  }

  const deliveries = new Set<string>();
  list<OperationInput["outbox"][number]>(input.outbox, "outbox").forEach((o, i) => {
    const p = `outbox[${i}]`;
    if (o === null || typeof o !== "object") return bad(p, "must be an object");
    only(o, ["deliveryId", "destination", "orderingKey", "priority", "aggregate", "payload", "notBefore"], p);
    checkId(o.deliveryId, `${p}.deliveryId`);
    if (deliveries.has(o.deliveryId)) bad(`${p}.deliveryId`, "appears twice in one operation");
    deliveries.add(o.deliveryId);
    checkText(o.destination, `${p}.destination`);
    if (o.orderingKey !== undefined) checkText(o.orderingKey, `${p}.orderingKey`);
    checkCount(o.priority, `${p}.priority`, 9);
    checkRef(o.aggregate, `${p}.aggregate`);
    if (deleted.has(refKey(o.aggregate))) bad(`${p}.aggregate`, "a removed aggregate cannot be announced by a message");
    if (!changed.has(refKey(o.aggregate))) bad(`${p}.aggregate`, "must be one of the aggregates this operation changes or checks, so the message records its revision");
    checkBody(o.payload, `${p}.payload`);
    if (o.notBefore !== undefined) checkTimestamp(o.notBefore, `${p}.notBefore`);
  });

  const effects = new Set<string>();
  list<OperationInput["effects"][number]>(input.effects, "effects").forEach((e, i) => {
    const p = `effects[${i}]`;
    if (e === null || typeof e !== "object") return bad(p, "must be an object");
    only(e, ["effectId", "attemptId", "target", "inputDigest", "reconciliationHandle"], p);
    checkId(e.effectId, `${p}.effectId`);
    if (effects.has(e.effectId)) bad(`${p}.effectId`, "appears twice in one operation");
    effects.add(e.effectId);
    if (e.attemptId !== undefined) checkId(e.attemptId, `${p}.attemptId`);
    checkText(e.target, `${p}.target`);
    if (typeof e.inputDigest !== "string" || !/^[0-9a-f]{64}$/.test(e.inputDigest)) bad(`${p}.inputDigest`, "must be a SHA-256 hex digest");
    if (e.reconciliationHandle !== undefined) checkText(e.reconciliationHandle, `${p}.reconciliationHandle`);
  });

  const timers = new Set<string>();
  list<OperationInput["timers"][number]>(input.timers, "timers").forEach((t, i) => {
    const p = `timers[${i}]`;
    if (t === null || typeof t !== "object") return bad(p, "must be an object");
    only(t, ["timerId", "dueAt", "aggregate", "payload"], p);
    checkId(t.timerId, `${p}.timerId`);
    if (timers.has(t.timerId)) bad(`${p}.timerId`, "appears twice in one operation");
    timers.add(t.timerId);
    checkTimestamp(t.dueAt, `${p}.dueAt`);
    if (t.aggregate !== undefined) checkRef(t.aggregate, `${p}.aggregate`);
    checkBody(t.payload, `${p}.payload`);
  });

  const cancelled = new Set<string>();
  list<string>(input.cancelTimers, "cancelTimers").forEach((id, i) => {
    checkId(id, `cancelTimers[${i}]`);
    if (timers.has(id)) bad(`cancelTimers[${i}]`, "cancels a timer this same operation creates");
    cancelled.add(id);
  });

  const seenDelivery = new Set<string>();
  list<OperationInput["completeDeliveries"][number]>(input.completeDeliveries, "completeDeliveries").forEach((c, i) => {
    const p = `completeDeliveries[${i}]`;
    if (c === null || typeof c !== "object") return bad(p, "must be an object");
    only(c, ["deliveryId", "claimToken", "receipt"], p);
    checkId(c.deliveryId, `${p}.deliveryId`);
    if (seenDelivery.has(c.deliveryId)) bad(`${p}.deliveryId`, "appears twice in one operation");
    seenDelivery.add(c.deliveryId);
    checkText(c.claimToken, `${p}.claimToken`);
    checkBody(c.receipt, `${p}.receipt`);
  });
  const seenTimer = new Set<string>();
  list<OperationInput["completeTimers"][number]>(input.completeTimers, "completeTimers").forEach((c, i) => {
    const p = `completeTimers[${i}]`;
    if (c === null || typeof c !== "object") return bad(p, "must be an object");
    only(c, ["timerId", "claimToken"], p);
    checkId(c.timerId, `${p}.timerId`);
    if (seenTimer.has(c.timerId)) bad(`${p}.timerId`, "appears twice in one operation");
    if (cancelled.has(c.timerId)) bad(`${p}.timerId`, "completes a timer this same operation cancels");
    seenTimer.add(c.timerId);
    checkText(c.claimToken, `${p}.claimToken`);
  });
  const seenEffect = new Set<string>();
  list<OperationInput["settleEffects"][number]>(input.settleEffects, "settleEffects").forEach((c, i) => {
    const p = `settleEffects[${i}]`;
    if (c === null || typeof c !== "object") return bad(p, "must be an object");
    only(c, ["effectId", "outcome", "evidence"], p);
    checkId(c.effectId, `${p}.effectId`);
    if (seenEffect.has(c.effectId)) bad(`${p}.effectId`, "appears twice in one operation");
    seenEffect.add(c.effectId);
    if (c.outcome !== "uncertain" && c.outcome !== "confirmed" && c.outcome !== "failed") bad(`${p}.outcome`, 'must be "uncertain", "confirmed" or "failed"');
    if (c.evidence !== undefined) checkBody(c.evidence, `${p}.evidence`);
  });
}
