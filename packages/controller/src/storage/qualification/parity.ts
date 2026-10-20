import assert from "node:assert/strict";
import { StorageError } from "../errors.js";
import type { Change, ControllerStorage, DeliveryClaim, JsonObject, OperationInput, TimerClaim } from "../types.js";

/**
 * Differential testing. One seeded random sequence of storage calls is run against several implementations; every result (or
 * error classification) and, at the end, the complete stored state must be identical. The first implementation is the guide: it
 * is asked for current revisions and live claim tokens so that the sequence exercises successes as well as every kind of
 * refusal (stale revisions, forged tokens, reused IDs, stale epochs, malformed input).
 */

/** A small deterministic generator (mulberry32), so a failing seed reproduces exactly. */
export function random(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export interface Backend { readonly name: string; readonly storage: ControllerStorage }
type Outcome = { readonly ok: true; readonly value: unknown } | { readonly ok: false; readonly error: string };

const BASE = Date.parse("2026-10-19T12:00:00.000Z");
const at = (ms: number): string => new Date(BASE + ms).toISOString();
const DIGEST = "0".repeat(64);
const KINDS = ["item", "grp"] as const;
const IDS = ["i0", "i1", "i2", "i3", "i4"];

async function outcomeOf(call: () => Promise<unknown>): Promise<Outcome> {
  try {
    // Round-trip through JSON so `undefined` fields and class instances cannot hide a difference.
    const value = await call();
    return { ok: true, value: value === undefined ? null : JSON.parse(JSON.stringify(value)) };
  } catch (error) {
    if (error instanceof StorageError) return { ok: false, error: error.kind === "invalid_input" ? `invalid_input@${error.path ?? ""}` : error.kind };
    throw error;
  }
}

const empty = (operationId: string, epoch: number, now: string): OperationInput => ({
  operationId, epoch, actor: "alice", correlationId: `c-${operationId}`, at: now, changes: [], audit: [], outbox: [], effects: [], timers: [], cancelTimers: [],
  completeDeliveries: [], completeTimers: [], settleEffects: [],
});

export interface ParityReport { readonly steps: number; readonly successes: number; readonly refusals: Record<string, number> }

/** Runs `steps` random calls against every backend and fails with the seed, step and both outcomes on the first difference. */
export async function runParity(seed: number, steps: number, backends: readonly Backend[]): Promise<ParityReport> {
  assert.ok(backends.length >= 2, "parity needs at least two backends");
  const guide = backends[0]!.storage;
  const rnd = random(seed);
  const pick = <T>(items: readonly T[]): T => items[Math.floor(rnd() * items.length)]!;
  const chance = (p: number): boolean => rnd() < p;
  let clock = 0;
  const submitted: OperationInput[] = [];
  const deliveryClaims: DeliveryClaim[] = [];
  const timerClaims: TimerClaim[] = [];
  let deliveries = 0;
  let effects = 0;
  let timers = 0;
  let successes = 0;
  const refusals: Record<string, number> = {};

  for (let n = 1; n <= steps; n++) {
    clock += pick([0, 500, 1000, 1000, 2000, 5000, 60_000]); // coarse steps, so lease and not-before boundaries are hit exactly
    const now = at(clock);
    const epoch = await guide.currentEpoch();
    const useEpoch = epoch === 0 ? 1 : chance(0.93) ? epoch : pick([epoch + 1, Math.max(1, epoch - 1)]);
    const roll = rnd();
    let label: string;
    let call: (s: ControllerStorage) => Promise<unknown>;

    if (epoch === 0 || roll < 0.02) {
      const expectedEpoch = chance(0.7) ? epoch : 99;
      const withExpected = chance(0.8);
      const holder = pick(["a", "b"]);
      label = `acquireEpoch(expected ${withExpected ? expectedEpoch : "none"})`;
      call = (s) => s.acquireEpoch({ holder, at: now, ...(withExpected ? { expectedEpoch } : {}) });
    } else if (roll < 0.09) {
      const op = submitted.length === 0 ? empty("empty", useEpoch, now) : pick(submitted);
      const replay = chance(0.3) ? { ...op, actor: `${op.actor}-changed` } : { ...op, at: at(clock + 86_400_000) };
      label = `replay ${op.operationId}`;
      call = (s) => s.applyOperation(replay);
    } else if (roll < 0.22) {
      const destination = pick(["x", "y"]);
      const leaseMs = pick([1000, 5000, 60_000]);
      const limit = pick([1, 2, 5]);
      label = `claimDeliveries ${destination}`;
      call = (s) => s.claimDeliveries({ epoch: useEpoch, destination, claimant: "w", now, leaseMs, limit });
    } else if (roll < 0.3) {
      const leaseMs = pick([1000, 60_000]);
      const limit = pick([1, 3]);
      label = "claimDueTimers";
      call = (s) => s.claimDueTimers({ epoch: useEpoch, claimant: "w", now, leaseMs, limit });
    } else if (roll < 0.35) {
      const held = deliveryClaims.length > 0 && chance(0.85) ? pick(deliveryClaims) : undefined;
      const deliveryId = held?.deliveryId ?? pick(["d1", "nope"]);
      const claimToken = held !== undefined && chance(0.85) ? held.claimToken : "bad-token";
      const nextAttemptAt = at(clock + pick([0, 2000, 30_000]));
      label = `retryDelivery ${deliveryId}`;
      call = (s) => s.retryDelivery({ epoch: useEpoch, deliveryId, claimToken, nextAttemptAt, reason: "parity", at: now });
    } else if (roll < 0.42) {
      const which = pick(["aggregate", "list", "audit", "delivery", "effect", "timer", "operation"]);
      const kind = pick(KINDS);
      const id = pick(IDS);
      const limit = pick([1, 3, 10]);
      const afterId = chance(0.5) ? pick(IDS) : undefined;
      const afterSeq = pick([0, 2, 5]);
      const number = Math.floor(rnd() * 12);
      const operationId = submitted.length > 0 ? pick(submitted).operationId : "none";
      label = `read ${which}`;
      call = async (s) => {
        switch (which) {
          case "aggregate": return s.getAggregate({ kind, id });
          case "list": return s.listAggregates(kind, { limit, ...(afterId === undefined ? {} : { afterId }) });
          case "audit": return s.listAudit({ afterSeq, limit: limit * 5 });
          case "delivery": return s.getDelivery(`d${number}`);
          case "effect": return s.getEffect(`e${number}`);
          case "timer": return s.getTimer(`t${number}`);
          default: return s.getOperation(operationId);
        }
      };
    } else {
      const changes: Change[] = [];
      const touched = new Set<string>();
      for (let i = Math.floor(rnd() * 4); i > 0; i--) {
        const kind = pick(KINDS);
        const id = pick(IDS);
        if (touched.has(`${kind}/${id}`)) continue;
        touched.add(`${kind}/${id}`);
        const current = await guide.getAggregate({ kind, id });
        const body: JsonObject = { n: Math.floor(rnd() * 100), tag: pick(["a", "b", "c"]), nested: { k: pick([1, 2, null]) } };
        const type = pick(["create", "update", "update", "check"] as const);
        const expected = current === undefined ? 1 : chance(0.85) ? current.revision : current.revision + pick([1, 2]);
        changes.push(type === "create" ? { type, ref: { kind, id }, body } : type === "update" ? { type, ref: { kind, id }, expectedRevision: expected, body } : { type, ref: { kind, id }, expectedRevision: expected });
      }
      const outbox = changes.length === 0 ? [] : Array.from({ length: Math.floor(rnd() * 3) }, () => {
        if (chance(0.9)) deliveries += 1; // otherwise reuse the last ID, to provoke duplicate_id
        const orderingKey = pick([undefined, undefined, "k1", "k2"]);
        return {
          deliveryId: `d${deliveries}`, destination: pick(["x", "y"]), priority: pick([0, 5, 5, 9]), aggregate: pick(changes).ref, payload: { p: Math.floor(rnd() * 10) },
          ...(orderingKey === undefined ? {} : { orderingKey }), ...(chance(0.15) ? { notBefore: at(clock + 3000) } : {}),
        };
      });
      const newEffects = chance(0.2) ? [{ effectId: `e${chance(0.9) ? ++effects : effects}`, target: "repo", inputDigest: DIGEST }] : [];
      const newTimers = chance(0.2) ? [{ timerId: `t${chance(0.9) ? ++timers : timers}`, dueAt: at(clock + pick([0, 1000, 5000])), payload: { why: "parity" } }] : [];
      const ghost = chance(0.12); // a completion or settlement of something that does not exist, alongside other faults
      const completeD = ghost ? ({ deliveryId: "ghost-d", claimToken: "x" } as DeliveryClaim) : deliveryClaims.length > 0 && chance(0.3) ? pick(deliveryClaims) : undefined;
      const completeT = ghost && chance(0.5) ? ({ timerId: "ghost-t", claimToken: "x" } as TimerClaim) : timerClaims.length > 0 && chance(0.25) ? pick(timerClaims) : undefined;
      const operation: OperationInput = {
        ...empty(chance(0.97) ? `o${n}` : "o1", useEpoch, now),
        actor: pick(["alice", "bob"]),
        changes,
        audit: Array.from({ length: Math.floor(rnd() * 3) }, () => ({ type: pick(["x.changed", "y.changed"]), detail: { v: Math.floor(rnd() * 5) } })),
        outbox, effects: newEffects, timers: newTimers,
        cancelTimers: chance(0.15) ? [`t${Math.max(1, Math.floor(rnd() * (timers + 1)))}`] : [],
        completeDeliveries: completeD === undefined ? [] : [{ deliveryId: completeD.deliveryId, claimToken: chance(0.8) ? completeD.claimToken : "forged", receipt: { ok: chance(0.8) } }],
        completeTimers: completeT === undefined ? [] : [{ timerId: completeT.timerId, claimToken: chance(0.8) ? completeT.claimToken : "forged" }],
        settleEffects: (effects > 0 && chance(0.25)) || ghost ? [{ effectId: ghost && chance(0.5) ? "ghost-e" : `e${1 + Math.floor(rnd() * Math.max(1, effects))}`, outcome: pick(["uncertain", "confirmed", "failed"] as const), ...(chance(0.4) ? { evidence: { by: "parity" } } : {}) }] : [],
      };
      submitted.push(operation);
      label = `applyOperation ${operation.operationId}`;
      call = (s) => s.applyOperation(operation);
    }

    const reference = await outcomeOf(() => call(guide));
    if (reference.ok) {
      successes += 1;
      if (Array.isArray(reference.value)) for (const item of reference.value as (DeliveryClaim | TimerClaim)[]) {
        if ("deliveryId" in item) deliveryClaims.push(item); else if ("timerId" in item) timerClaims.push(item);
      }
    } else refusals[reference.error] = (refusals[reference.error] ?? 0) + 1;
    for (const other of backends.slice(1)) {
      const got = await outcomeOf(() => call(other.storage));
      try {
        assert.deepEqual(got, reference);
      } catch {
        throw new Error(`parity failure, seed ${seed}, step ${n} (${label}): ${backends[0]!.name} gave ${JSON.stringify(reference).slice(0, 600)} but ${other.name} gave ${JSON.stringify(got).slice(0, 600)}`);
      }
    }
  }

  const view = async (s: ControllerStorage): Promise<unknown> => {
    const aggregates = [];
    for (const kind of KINDS) aggregates.push(await s.listAggregates(kind, { limit: 1000 }));
    const many = async <T>(prefix: string, count: number, read: (id: string) => Promise<T | undefined>) => Promise.all(Array.from({ length: count + 2 }, (_, i) => read(`${prefix}${i}`)));
    return JSON.parse(JSON.stringify({
      epoch: await s.currentEpoch(), aggregates, audit: await s.listAudit({ afterSeq: 0, limit: 1000 }),
      deliveries: await many("d", deliveries, (id) => s.getDelivery(id)), effects: await many("e", effects, (id) => s.getEffect(id)), timers: await many("t", timers, (id) => s.getTimer(id)),
      operations: await Promise.all([...new Set(submitted.map((o) => o.operationId))].map((id) => s.getOperation(id))),
    }));
  };
  const reference = await view(guide);
  for (const other of backends.slice(1)) {
    try {
      assert.deepEqual(await view(other.storage), reference);
    } catch (error) {
      throw new Error(`parity failure, seed ${seed}: final state of ${other.name} differs from ${backends[0]!.name}: ${error instanceof Error ? error.message.slice(0, 1500) : String(error)}`);
    }
  }
  return { steps, successes, refusals };
}
