import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { commitOperation } from "./commit.js";
import { StorageError, isStorageError, type StorageErrorKind } from "./errors.js";
import { FaultInjectingStorage } from "./faults.js";
import { operationHash } from "./hash.js";
import { sha256 } from "./json.js";
import type { Change, ControllerStorage, JsonObject, OperationInput } from "./types.js";

/**
 * The shared semantic fixtures: one suite that every `ControllerStorage` implementation must pass unchanged. A backend that
 * cannot pass it does not get to be a backend (see the storage choice in the design proposal). Adapters supply `open`, which
 * returns a fresh, empty storage each time, and run the suite from their own test file.
 */
export interface StorageHarness {
  readonly name: string;
  open(): Promise<{ storage: ControllerStorage; close?: () => Promise<void> }>;
}

const T0 = "2026-10-19T12:00:00.000Z";
const at = (ms: number): string => new Date(Date.parse(T0) + ms).toISOString();
const DIGEST = sha256("input");

const op = (operationId: string, over: Partial<OperationInput> = {}): OperationInput => ({
  operationId, epoch: 1, actor: "agent-a", correlationId: `corr-${operationId}`, at: T0, changes: [], audit: [], outbox: [], effects: [], timers: [], cancelTimers: [],
  completeDeliveries: [], completeTimers: [], settleEffects: [], ...over,
});

let counter = 0;
/** Records a receipt through the single write primitive, as a handler would. */
const done = (s: ControllerStorage, deliveryId: string, claimToken: string, receipt: JsonObject, atMs = 0, over: Partial<OperationInput> = {}) =>
  s.applyOperation(op(`done-${deliveryId}-${counter++}`, { completeDeliveries: [{ deliveryId, claimToken, receipt }], at: at(atMs), ...over }));
const fire = (s: ControllerStorage, timerId: string, claimToken: string, atMs = 0) =>
  s.applyOperation(op(`fire-${timerId}-${counter++}`, { completeTimers: [{ timerId, claimToken }], at: at(atMs) }));
const settle = (s: ControllerStorage, effectId: string, outcome: "uncertain" | "confirmed" | "failed", evidence?: JsonObject, atMs = 0) =>
  s.applyOperation(op(`settle-${effectId}-${counter++}`, { settleEffects: [{ effectId, outcome, ...(evidence === undefined ? {} : { evidence }) }], at: at(atMs) }));
const ref = (kind: string, id: string) => ({ kind, id });
const create = (kind: string, id: string, body: JsonObject = { n: 0 }): Change => ({ type: "create", ref: ref(kind, id), body });
const update = (kind: string, id: string, expectedRevision: number, body: JsonObject): Change => ({ type: "update", ref: ref(kind, id), expectedRevision, body });
const outbox = (deliveryId: string, over: Partial<OperationInput["outbox"][number]> = {}): OperationInput["outbox"][number] => ({
  deliveryId, destination: "workers", priority: 5, aggregate: ref("task", "t1"), payload: { id: deliveryId }, ...over,
});
const note = (type = "task.changed"): OperationInput["audit"][number] => ({ type, subject: ref("task", "t1"), detail: { why: "test" } });

async function kindOf(promise: Promise<unknown>): Promise<StorageErrorKind | "ok"> {
  try { await promise; return "ok"; } catch (error) { if (error instanceof StorageError) return error.kind; throw error; }
}
const expectKind = async (promise: Promise<unknown>, kind: StorageErrorKind): Promise<void> => assert.equal(await kindOf(promise), kind);

export function runStorageConformance(harness: StorageHarness): void {
  const withStore = (name: string, body: (s: ControllerStorage) => Promise<void>, options: { epoch?: boolean } = {}) =>
    // Each case has its own bound, so a hang is reported quickly and by name, whatever the file-level bound is for slow server startups.
    test(name, { timeout: 60_000 }, async () => {
      const { storage, close } = await harness.open();
      try {
        if (options.epoch !== false) await storage.acquireEpoch({ holder: "controller-1", at: T0 });
        await body(storage);
      } finally {
        await (close?.() ?? storage.close());
      }
    });

  /** Nothing from `operationId` may be visible anywhere. */
  async function assertNothingCommitted(s: ControllerStorage, operationId: string, extra: { aggregates?: [string, string][]; deliveries?: string[]; effects?: string[]; timers?: string[] } = {}): Promise<void> {
    assert.equal(await s.getOperation(operationId), undefined, "the operation record was written");
    assert.deepEqual(await s.listAudit({ afterSeq: 0, limit: 1000 }), [], "audit entries were written");
    for (const [kind, id] of extra.aggregates ?? []) assert.equal(await s.getAggregate(ref(kind, id)), undefined, `${kind}/${id} was written`);
    for (const id of extra.deliveries ?? []) assert.equal(await s.getDelivery(id), undefined, `delivery ${id} was written`);
    for (const id of extra.effects ?? []) assert.equal(await s.getEffect(id), undefined, `effect ${id} was written`);
    for (const id of extra.timers ?? []) assert.equal(await s.getTimer(id), undefined, `timer ${id} was written`);
  }

  describe(`controller storage conformance: ${harness.name}`, () => {
    // -------------------------------------------------------------------------------------------- epochs
    describe("epochs", () => {
      withStore("start at 0, rise by 1 on every acquisition, and support compare-and-set takeover", async (s) => {
        assert.equal(await s.currentEpoch(), 0);
        assert.deepEqual(await s.acquireEpoch({ holder: "a", at: T0 }), { epoch: 1 });
        assert.deepEqual(await s.acquireEpoch({ holder: "b", at: T0, expectedEpoch: 1 }), { epoch: 2 });
        await expectKind(s.acquireEpoch({ holder: "c", at: T0, expectedEpoch: 1 }), "stale_epoch");
        assert.equal(await s.currentEpoch(), 2, "a failed takeover must not move the epoch");
      }, { epoch: false });

      withStore("reject every operation until a controller owns an epoch, and operations from an older epoch afterwards", async (s) => {
        await expectKind(s.applyOperation(op("early", { changes: [create("task", "t1")] })), "stale_epoch");
        await s.acquireEpoch({ holder: "a", at: T0 });
        await s.applyOperation(op("ok-1", { changes: [create("task", "t1")] }));
        await s.acquireEpoch({ holder: "b", at: T0, expectedEpoch: 1 });
        await expectKind(s.applyOperation(op("old", { epoch: 1, changes: [update("task", "t1", 1, { n: 1 })] })), "stale_epoch");
        await expectKind(s.applyOperation(op("future", { epoch: 3, changes: [update("task", "t1", 1, { n: 1 })] })), "stale_epoch");
        assert.equal((await s.getAggregate(ref("task", "t1")))?.revision, 1);
        assert.equal(await s.getOperation("old"), undefined);
        const fresh = await s.applyOperation(op("new", { epoch: 2, changes: [update("task", "t1", 1, { n: 1 })] }));
        assert.equal(fresh.epoch, 2);
      }, { epoch: false });

      withStore("answer a repeat of an already committed operation even after the epoch moved on", async (s) => {
        const original = op("once", { changes: [create("task", "t1")], audit: [note()] });
        const first = await s.applyOperation(original);
        await s.acquireEpoch({ holder: "b", at: T0, expectedEpoch: 1 });
        const again = await s.applyOperation(original);
        assert.equal(again.replayed, true);
        assert.deepEqual({ ...again, replayed: false }, first);
        assert.equal((await s.listAudit({ afterSeq: 0, limit: 10 })).length, 1);
      });
    });

    // --------------------------------------------------------------------------- fencing of every write
    describe("fencing a deposed controller", () => {
      withStore("refuse every write from an old epoch after a takeover, and change nothing", async (s) => {
        await s.applyOperation(op("seed", {
          changes: [create("task", "t1")], outbox: [outbox("d1"), outbox("d2")], effects: [{ effectId: "e1", target: "x", inputDigest: DIGEST }], timers: [{ timerId: "tm1", dueAt: at(0), payload: {} }, { timerId: "tm2", dueAt: at(0), payload: {} }],
        }));
        const [claimed] = await s.claimDeliveries({ epoch: 1, destination: "workers", claimant: "old", now: at(10), leaseMs: 100_000, limit: 1 });
        const [timer] = await s.claimDueTimers({ epoch: 1, claimant: "old", now: at(10), leaseMs: 100_000, limit: 1 });
        await s.acquireEpoch({ holder: "new", at: at(20), expectedEpoch: 1 });

        await expectKind(s.claimDeliveries({ epoch: 1, destination: "workers", claimant: "old", now: at(30), leaseMs: 1000, limit: 5 }), "stale_epoch");
        await expectKind(s.claimDueTimers({ epoch: 1, claimant: "old", now: at(30), leaseMs: 1000, limit: 5 }), "stale_epoch");
        await expectKind(s.retryDelivery({ epoch: 1, deliveryId: claimed!.deliveryId, claimToken: claimed!.claimToken, nextAttemptAt: at(99), reason: "x", at: at(30) }), "stale_epoch");
        await expectKind(done(s, claimed!.deliveryId, claimed!.claimToken, { ok: true }, 30), "stale_epoch");
        await expectKind(fire(s, timer!.timerId, timer!.claimToken, 30), "stale_epoch");
        await expectKind(settle(s, "e1", "confirmed", undefined, 30), "stale_epoch");
        await expectKind(s.applyOperation(op("old-write", { changes: [update("task", "t1", 1, { n: 1 })] })), "stale_epoch");

        assert.deepEqual([(await s.getDelivery(claimed!.deliveryId))?.state, (await s.getDelivery(claimed!.deliveryId))?.attempts, (await s.getTimer(timer!.timerId))?.state, (await s.getEffect("e1"))?.status, (await s.getAggregate(ref("task", "t1")))?.revision], ["claimed", 1, "claimed", "intended", 1]);
        const fresh = await s.claimDeliveries({ epoch: 2, destination: "workers", claimant: "new", now: at(200_000), leaseMs: 1000, limit: 5 });
        assert.equal(fresh.length, 2, "the new primary can reclaim once the old leases expire");
        await expectKind(s.claimDeliveries({ epoch: 3, destination: "workers", claimant: "x", now: at(200_000), leaseMs: 1000, limit: 5 }), "stale_epoch");
        await expectKind(s.claimDeliveries({ epoch: 0, destination: "workers", claimant: "x", now: at(200_000), leaseMs: 1000, limit: 5 }), "invalid_input");
      });

      withStore("refuse claims and retries before any controller owns an epoch", async (s) => {
        await expectKind(s.claimDeliveries({ epoch: 1, destination: "workers", claimant: "x", now: T0, leaseMs: 1000, limit: 1 }), "stale_epoch");
        await expectKind(s.claimDueTimers({ epoch: 1, claimant: "x", now: T0, leaseMs: 1000, limit: 1 }), "stale_epoch");
      }, { epoch: false });
    });

    // ------------------------------------------------------------------------------------ atomicity
    describe("atomic commit of transition, audit, outbox, effects and timers", () => {
      withStore("makes every part visible together, with consistent revisions and sequence numbers", async (s) => {
        const result = await s.applyOperation(op("all", {
          changes: [create("task", "t1", { state: "ready" }), create("project", "p1", { name: "x" })],
          audit: [note("task.created"), note("project.created")],
          outbox: [outbox("d1", { aggregate: ref("task", "t1"), orderingKey: "t1" })],
          effects: [{ effectId: "e1", attemptId: "a1", target: "repo:main", inputDigest: DIGEST, reconciliationHandle: "h1" }],
          timers: [{ timerId: "tm1", dueAt: at(1000), aggregate: ref("task", "t1"), payload: { kind: "deadline" } }],
        }));
        assert.deepEqual(result, { operationId: "all", replayed: false, revisions: [{ ref: ref("task", "t1"), revision: 1 }, { ref: ref("project", "p1"), revision: 1 }], auditSeqs: [1, 2], epoch: 1 });
        const task = await s.getAggregate(ref("task", "t1"));
        assert.deepEqual([task?.revision, task?.body, task?.createdAt, task?.updatedAt], [1, { state: "ready" }, T0, T0]);
        assert.deepEqual((await s.listAudit({ afterSeq: 0, limit: 10 })).map((a) => [a.seq, a.type, a.operationId, a.actor, a.correlationId]), [[1, "task.created", "all", "agent-a", "corr-all"], [2, "project.created", "all", "agent-a", "corr-all"]]);
        const delivery = await s.getDelivery("d1");
        assert.deepEqual([delivery?.state, delivery?.aggregateRevision, delivery?.attempts, delivery?.nextAttemptAt], ["pending", 1, 0, T0]);
        const effect = await s.getEffect("e1");
        assert.deepEqual([effect?.status, effect?.operationId, effect?.attemptId, effect?.reconciliationHandle], ["intended", "all", "a1", "h1"]);
        assert.deepEqual((await s.getTimer("tm1"))?.state, "pending");
        const stored = await s.getOperation("all");
        assert.equal(stored?.requestHash, operationHash(op("all", { changes: [create("task", "t1", { state: "ready" }), create("project", "p1", { name: "x" })], audit: [note("task.created"), note("project.created")], outbox: [outbox("d1", { aggregate: ref("task", "t1"), orderingKey: "t1" })], effects: [{ effectId: "e1", attemptId: "a1", target: "repo:main", inputDigest: DIGEST, reconciliationHandle: "h1" }], timers: [{ timerId: "tm1", dueAt: at(1000), aggregate: ref("task", "t1"), payload: { kind: "deadline" } }] })));
      });

      withStore("leave no trace of any part when one change fails its revision check", async (s) => {
        await s.applyOperation(op("seed", { changes: [create("task", "t0")] }));
        const before = (await s.listAudit({ afterSeq: 0, limit: 100 })).length;
        await expectKind(s.applyOperation(op("bad", {
          changes: [create("task", "t1"), update("task", "t0", 7, { n: 9 })],
          audit: [note()], outbox: [outbox("d1")], effects: [{ effectId: "e1", target: "x", inputDigest: DIGEST }], timers: [{ timerId: "tm1", dueAt: at(1), payload: {} }],
        })), "revision_conflict");
        assert.equal(await s.getOperation("bad"), undefined);
        assert.equal(await s.getAggregate(ref("task", "t1")), undefined);
        assert.equal((await s.getAggregate(ref("task", "t0")))?.revision, 1);
        assert.equal((await s.listAudit({ afterSeq: 0, limit: 100 })).length, before);
        assert.equal(await s.getDelivery("d1"), undefined);
        assert.equal(await s.getEffect("e1"), undefined);
        assert.equal(await s.getTimer("tm1"), undefined);
      });

      for (const taken of ["delivery", "effect", "timer"] as const) {
        withStore(`leave no trace when a ${taken} ID is already taken by another operation`, async (s) => {
          await s.applyOperation(op("first", {
            changes: [create("task", "t1")], outbox: [outbox("dup")], effects: [{ effectId: "dup", target: "x", inputDigest: DIGEST }], timers: [{ timerId: "dup", dueAt: at(1), payload: {} }],
          }));
          const second = op("second", {
            changes: [create("task", "t2")], audit: [note()],
            outbox: [outbox(taken === "delivery" ? "dup" : "fresh", { aggregate: ref("task", "t2") })],
            effects: taken === "effect" ? [{ effectId: "dup", target: "x", inputDigest: DIGEST }] : [],
            timers: taken === "timer" ? [{ timerId: "dup", dueAt: at(2), payload: {} }] : [],
          });
          await expectKind(s.applyOperation(second), "duplicate_id");
          assert.equal(await s.getOperation("second"), undefined);
          assert.equal(await s.getAggregate(ref("task", "t2")), undefined);
          assert.equal(await s.getDelivery("fresh"), undefined);
          assert.deepEqual(await s.listAudit({ afterSeq: 0, limit: 10 }), []);
        });
      }
    });

    // ------------------------------------------------------------------------------ idempotency
    describe("operation identity", () => {
      withStore("treats an identical repeat as the same admission and does the work once", async (s) => {
        const command = op("cmd", { changes: [create("task", "t1")], audit: [note()], outbox: [outbox("d1")], timers: [{ timerId: "tm1", dueAt: at(1), payload: {} }] });
        const first = await s.applyOperation(command);
        const again = await s.applyOperation({ ...command, at: at(5000) });
        assert.equal(first.replayed, false);
        assert.equal(again.replayed, true);
        assert.deepEqual({ ...again, replayed: false }, first);
        assert.equal((await s.getAggregate(ref("task", "t1")))?.revision, 1);
        assert.equal((await s.listAudit({ afterSeq: 0, limit: 10 })).length, 1);
        assert.equal((await s.getDelivery("d1"))?.seq, 1);
      });

      withStore("rejects an operation ID reused with any different content, and changes nothing", async (s) => {
        const base = op("cmd", { changes: [create("task", "t1", { a: 1 })], audit: [note()] });
        await s.applyOperation(base);
        const variants: OperationInput[] = [
          { ...base, changes: [create("task", "t1", { a: 2 })] },
          { ...base, actor: "agent-b" },
          { ...base, correlationId: "other" },
          { ...base, audit: [note("task.other")] },
          { ...base, outbox: [outbox("dx")] },
          { ...base, cancelTimers: ["tm9"] },
        ];
        for (const [i, variant] of variants.entries()) await expectKind(s.applyOperation(variant), "idempotency_conflict").catch((e) => { throw new Error(`variant ${i}: ${e}`); });
        assert.equal((await s.getAggregate(ref("task", "t1")))?.revision, 1);
        assert.deepEqual((await s.getAggregate(ref("task", "t1")))?.body, { a: 1 });
        assert.equal((await s.listAudit({ afterSeq: 0, limit: 10 })).length, 1);
      });

      withStore("ignores key order, epoch and issue time when comparing, and accepts the same content under a new ID", async (s) => {
        const a = op("cmd-a", { changes: [create("task", "t1", { x: 1, y: { p: 1, q: 2 } })] });
        await s.applyOperation(a);
        const reordered = op("cmd-a", { changes: [create("task", "t1", { y: { q: 2, p: 1 }, x: 1 })], at: at(99) });
        assert.equal((await s.applyOperation(reordered)).replayed, true);
        const audit = (id: string) => op(id, { audit: [note()] });
        await s.applyOperation(audit("m1"));
        await s.applyOperation(audit("m2"));
        assert.equal((await s.listAudit({ afterSeq: 0, limit: 10 })).length, 2);
      });

      withStore("map a race on the operation key to retryable (never a raw driver error) and replay on the retry", async (s) => {
        const command = op("race-raw", { changes: [create("task", "t1")], audit: [note()], outbox: [outbox("d1")] });
        const outcomes = await Promise.all(Array.from({ length: 8 }, () => s.applyOperation(command).then((r) => (r.replayed ? "replayed" : "first"), (e: unknown) => (e instanceof StorageError ? e.kind : `UNMAPPED ${String(e)}`))));
        for (const o of outcomes) assert.ok(["first", "replayed", "retryable"].includes(o), `unexpected outcome ${o}`);
        assert.equal(outcomes.filter((o) => o === "first").length, 1, outcomes.join());
        assert.equal((await s.listAudit({ afterSeq: 0, limit: 100 })).length, 1);
      });

      withStore("give a delivery, effect or timer ID to exactly one of two racing operations", async (s) => {
        for (const kind of ["delivery", "effect", "timer"] as const) {
          const racer = (i: number) => op(`${kind}-racer-${i}`, {
            changes: [create("task", `${kind}-${i}`)], audit: [note()],
            outbox: kind === "delivery" ? [outbox("shared", { aggregate: ref("task", `${kind}-${i}`) })] : [],
            effects: kind === "effect" ? [{ effectId: "shared", target: "x", inputDigest: DIGEST }] : [],
            timers: kind === "timer" ? [{ timerId: "shared", dueAt: at(1), payload: {} }] : [],
          });
          const outcomes = await Promise.all([0, 1, 2, 3].map((i) => kindOf(commitOperation(s, racer(i), { attempts: 20 }))));
          assert.equal(outcomes.filter((o) => o === "ok").length, 1, `${kind}: ${outcomes.join()}`);
          assert.equal(outcomes.filter((o) => o === "duplicate_id").length, 3, `${kind}: ${outcomes.join()}`);
          const written = (await Promise.all([0, 1, 2, 3].map((i) => s.getAggregate(ref("task", `${kind}-${i}`))))).filter((a) => a !== undefined);
          assert.equal(written.length, 1, `${kind}: a losing operation left its aggregate behind`);
        }
      });

      withStore("lets exactly one of many concurrent identical submissions do the work", async (s) => {
        const command = op("race", { changes: [create("task", "t1")], audit: [note()], outbox: [outbox("d1")] });
        const results = await Promise.all(Array.from({ length: 8 }, () => commitOperation(s, command, { attempts: 10 })));
        assert.equal(results.filter((r) => !r.replayed).length, 1);
        assert.equal((await s.getAggregate(ref("task", "t1")))?.revision, 1);
        assert.equal((await s.listAudit({ afterSeq: 0, limit: 100 })).length, 1);
      });
    });

    // ------------------------------------------------------------------------------------ revisions
    describe("revision checks", () => {
      withStore("count revisions from 1, by exactly 1 per update, and leave checks alone", async (s) => {
        await s.applyOperation(op("c", { changes: [create("task", "t1", { n: 0 })] }));
        const u = await s.applyOperation(op("u1", { changes: [update("task", "t1", 1, { n: 1 })], at: at(10) }));
        assert.deepEqual(u.revisions, [{ ref: ref("task", "t1"), revision: 2 }]);
        const k = await s.applyOperation(op("k", { changes: [{ type: "check", ref: ref("task", "t1"), expectedRevision: 2 }] }));
        assert.deepEqual(k.revisions, [{ ref: ref("task", "t1"), revision: 2 }]);
        const task = await s.getAggregate(ref("task", "t1"));
        assert.deepEqual([task?.revision, task?.body, task?.createdAt, task?.updatedAt], [2, { n: 1 }, T0, at(10)]);
      });

      withStore("refuse stale, missing and duplicate targets with the right classification", async (s) => {
        await s.applyOperation(op("c", { changes: [create("task", "t1")] }));
        await expectKind(s.applyOperation(op("a", { changes: [create("task", "t1")] })), "revision_conflict");
        await expectKind(s.applyOperation(op("b", { changes: [update("task", "t1", 5, { n: 1 })] })), "revision_conflict");
        await expectKind(s.applyOperation(op("c2", { changes: [update("task", "nope", 1, { n: 1 })] })), "not_found");
        await expectKind(s.applyOperation(op("d", { changes: [{ type: "check", ref: ref("task", "t1"), expectedRevision: 9 }] })), "revision_conflict");
        await expectKind(s.applyOperation(op("e", { changes: [{ type: "check", ref: ref("task", "nope"), expectedRevision: 1 }] })), "not_found");
        assert.equal((await s.getAggregate(ref("task", "t1")))?.revision, 1);
      });

      withStore("let exactly one of many concurrent writers win on the same expected revision", async (s) => {
        await s.applyOperation(op("c", { changes: [create("task", "t1", { n: 0 })] }));
        const outcomes = await Promise.all(Array.from({ length: 10 }, (_, i) =>
          kindOf(commitOperation(s, op(`w${i}`, { changes: [update("task", "t1", 1, { n: i + 1 })], audit: [note()] }), { attempts: 20 }))));
        assert.equal(outcomes.filter((k) => k === "ok").length, 1, outcomes.join());
        assert.equal(outcomes.filter((k) => k === "revision_conflict").length, 9, outcomes.join());
        assert.equal((await s.getAggregate(ref("task", "t1")))?.revision, 2);
        assert.equal((await s.listAudit({ afterSeq: 0, limit: 100 })).length, 1, "a losing writer left an audit entry");
      });

      withStore("let exactly one of many concurrent creators win", async (s) => {
        const outcomes = await Promise.all(Array.from({ length: 8 }, (_, i) => kindOf(commitOperation(s, op(`c${i}`, { changes: [create("task", "t1", { by: i })] }), { attempts: 20 }))));
        assert.equal(outcomes.filter((k) => k === "ok").length, 1, outcomes.join());
        assert.equal((await s.getAggregate(ref("task", "t1")))?.revision, 1);
      });
    });

    // ----------------------------------------------------------------------------------------- audit
    describe("audit trail", () => {
      withStore("is gap-free and ordered across operations, carries attribution, and pages", async (s) => {
        await s.applyOperation(op("o1", { audit: [note("a"), note("b")], actor: "x", at: at(1) }));
        await s.applyOperation(op("o2", { audit: [note("c")], actor: "y", at: at(2) }));
        const all = await s.listAudit({ afterSeq: 0, limit: 10 });
        assert.deepEqual(all.map((a) => [a.seq, a.type, a.operationId, a.actor, a.at]), [[1, "a", "o1", "x", at(1)], [2, "b", "o1", "x", at(1)], [3, "c", "o2", "y", at(2)]]);
        assert.deepEqual(all[0]?.subject, ref("task", "t1"));
        assert.deepEqual(all[0]?.detail, { why: "test" });
        assert.deepEqual((await s.listAudit({ afterSeq: 1, limit: 1 })).map((a) => a.seq), [2]);
        assert.deepEqual((await s.listAudit({ afterSeq: 3, limit: 5 })), []);
      });

      withStore("keeps a failed operation out of the sequence, so numbers stay gap-free", async (s) => {
        await s.applyOperation(op("o1", { audit: [note()] }));
        await expectKind(s.applyOperation(op("bad", { audit: [note()], changes: [update("task", "none", 1, {})] })), "not_found");
        await s.applyOperation(op("o2", { audit: [note()] }));
        assert.deepEqual((await s.listAudit({ afterSeq: 0, limit: 10 })).map((a) => a.seq), [1, 2]);
      });
    });

    // ----------------------------------------------------------------------------------------- outbox
    describe("delivery claims", () => {
      const seedDeliveries = async (s: ControllerStorage, entries: { id: string; over?: Partial<OperationInput["outbox"][number]> }[]) => {
        await s.applyOperation(op("seed-task", { changes: [create("task", "t1")] }));
        for (const [i, e] of entries.entries()) await s.applyOperation(op(`seed-${e.id}`, { changes: [{ type: "check", ref: ref("task", "t1"), expectedRevision: 1 }], outbox: [outbox(e.id, e.over)], at: at(i) }));
      };
      const claim = (s: ControllerStorage, now: string, over: Partial<Parameters<ControllerStorage["claimDeliveries"]>[0]> = {}) =>
        s.claimDeliveries({ epoch: 1, destination: "workers", claimant: "w1", now, leaseMs: 1000, limit: 10, ...over });

      withStore("claim only due deliveries of the asked destination, highest priority first, then in commit order", async (s) => {
        await seedDeliveries(s, [
          { id: "low", over: { priority: 1 } }, { id: "high", over: { priority: 9 } }, { id: "mid-a" }, { id: "mid-b" },
          { id: "later", over: { notBefore: at(60_000) } }, { id: "elsewhere", over: { destination: "other" } },
        ]);
        const claims = await claim(s, at(1000), { leaseMs: 10_000_000 });
        assert.deepEqual(claims.map((c) => c.deliveryId), ["high", "mid-a", "mid-b", "low"]);
        assert.deepEqual(claims.map((c) => [c.attempt, c.aggregateRevision, c.aggregate]), claims.map(() => [1, 1, ref("task", "t1")]));
        assert.equal((await claim(s, at(1500), { limit: 5 })).length, 0, "claimed deliveries must not be claimable again while leased");
        assert.deepEqual((await claim(s, at(61_000), { leaseMs: 10_000_000 })).map((c) => c.deliveryId), ["later"]);
        assert.deepEqual((await claim(s, at(61_000), { destination: "other", leaseMs: 10_000_000 })).map((c) => c.deliveryId), ["elsewhere"]);
        assert.deepEqual((await claim(s, at(61_000), { limit: 1 })), []);
      });

      withStore("respect the limit", async (s) => {
        await seedDeliveries(s, [{ id: "a" }, { id: "b" }, { id: "c" }]);
        assert.deepEqual((await claim(s, at(10), { limit: 2 })).map((c) => c.deliveryId), ["a", "b"]);
        assert.deepEqual((await claim(s, at(10), { limit: 2 })).map((c) => c.deliveryId), ["c"]);
      });

      withStore("deliver one ordering key strictly in commit order, and different keys independently", async (s) => {
        await seedDeliveries(s, [
          { id: "k1-1", over: { orderingKey: "k1" } }, { id: "k1-2", over: { orderingKey: "k1", priority: 9 } }, { id: "k2-1", over: { orderingKey: "k2" } }, { id: "free" },
        ]);
        const first = await claim(s, at(10));
        assert.deepEqual(first.map((c) => c.deliveryId).sort(), ["free", "k1-1", "k2-1"], "priority must not let a later message of a key overtake an earlier one");
        assert.deepEqual(await claim(s, at(11)), []);
        await done(s, "k1-1", first.find((c) => c.deliveryId === "k1-1")!.claimToken, { ok: true }, 12);
        assert.deepEqual((await claim(s, at(13))).map((c) => c.deliveryId), ["k1-2"]);
      });

      withStore("keep later messages of a key waiting while an earlier one is retried later", async (s) => {
        await seedDeliveries(s, [{ id: "m1", over: { orderingKey: "k" } }, { id: "m2", over: { orderingKey: "k" } }]);
        const [c1] = await claim(s, at(10));
        await s.retryDelivery({ epoch: 1, deliveryId: "m1", claimToken: c1!.claimToken, nextAttemptAt: at(10_000), reason: "destination down", at: at(11) });
        assert.deepEqual(await claim(s, at(5000)), [], "m2 must not overtake m1");
        const record = await s.getDelivery("m1");
        assert.deepEqual([record?.state, record?.attempts, record?.nextAttemptAt, record?.lastError], ["pending", 1, at(10_000), "destination down"]);
        const retried = await claim(s, at(10_000));
        assert.deepEqual(retried.map((c) => [c.deliveryId, c.attempt]), [["m1", 2]]);
      });

      withStore("let another claimant take a delivery only after its lease ends, and invalidate the old claim", async (s) => {
        await seedDeliveries(s, [{ id: "d" }]);
        const [first] = await claim(s, at(0), { leaseMs: 1000 });
        assert.equal(first?.claimedUntil, at(1000));
        assert.deepEqual(await claim(s, at(999), { claimant: "w2" }), []);
        const [second] = await claim(s, at(1000), { claimant: "w2" });
        assert.equal(second?.attempt, 2);
        assert.notEqual(second?.claimToken, first?.claimToken);
        await expectKind(done(s, "d", first!.claimToken, { by: "w1" }, 1001), "state_conflict");
        await expectKind(s.retryDelivery({ epoch: 1, deliveryId: "d", claimToken: first!.claimToken, nextAttemptAt: at(2000), reason: "x", at: at(1001) }), "state_conflict");
        await done(s, "d", second!.claimToken, { by: "w2" }, 1002);
        assert.equal((await s.getDelivery("d"))?.state, "delivered");
      });

      withStore("accept a late completion from the current claim holder when nobody else took over", async (s) => {
        await seedDeliveries(s, [{ id: "d" }]);
        const [c] = await claim(s, at(0), { leaseMs: 1000 });
        await done(s, "d", c!.claimToken, { late: true }, 5000);
        assert.equal((await s.getDelivery("d"))?.state, "delivered");
      });

      withStore("record a durable receipt once, repeat it harmlessly, and refuse a different one", async (s) => {
        await seedDeliveries(s, [{ id: "d" }]);
        const [c] = await claim(s, at(0));
        await done(s, "d", c!.claimToken, { id: 7, ok: true }, 5);
        await done(s, "d", c!.claimToken, { ok: true, id: 7 }, 6);
        await done(s, "d", "any-other-token", { ok: true, id: 7 }, 6);
        await expectKind(done(s, "d", c!.claimToken, { id: 8 }, 7), "state_conflict");
        const record = await s.getDelivery("d");
        assert.deepEqual([record?.state, record?.receipt, record?.deliveredAt, "claimedUntil" in (record ?? {})], ["delivered", { id: 7, ok: true }, at(5), false]);
        assert.deepEqual(await claim(s, at(100_000)), [], "a delivered message is never claimed again");
        await expectKind(done(s, "ghost", "x", {}, 1), "not_found");
      });

      withStore("refuse completion by someone who does not hold the claim, including before any claim", async (s) => {
        await seedDeliveries(s, [{ id: "d" }]);
        await expectKind(done(s, "d", "d#1", {}, 1), "state_conflict");
        const [c] = await claim(s, at(0));
        await expectKind(done(s, "d", `${c!.claimToken}-forged`, {}, 1), "state_conflict");
        assert.equal((await s.getDelivery("d"))?.state, "claimed");
      });

      withStore("never give one delivery to two concurrent claimants", async (s) => {
        await seedDeliveries(s, Array.from({ length: 20 }, (_, i) => ({ id: `d${String(i).padStart(2, "0")}` })));
        const batches = await Promise.all(Array.from({ length: 6 }, (_, i) => commitClaim(s, `w${i}`, at(1000))));
        const ids = batches.flat().map((c) => c.deliveryId);
        assert.equal(ids.length, new Set(ids).size, `duplicate claims: ${ids.sort().join()}`);
        assert.equal(ids.length, 20);
      });

      withStore("never give two concurrent claimants the head of one ordering key", async (s) => {
        await seedDeliveries(s, Array.from({ length: 5 }, (_, i) => ({ id: `m${i}`, over: { orderingKey: "chain" } })));
        const batches = await Promise.all(Array.from({ length: 6 }, (_, i) => commitClaim(s, `w${i}`, at(1000))));
        assert.deepEqual(batches.flat().map((c) => c.deliveryId), ["m0"]);
      });

      /** Claims, rerunning retryable failures the way a real caller would. */
      async function commitClaim(s: ControllerStorage, claimant: string, now: string) {
        for (let attempt = 0; attempt < 20; attempt++) {
          try { return await claim(s, now, { claimant }); } catch (error) { if (!isStorageError(error, "retryable")) throw error; }
        }
        throw new Error("claim kept failing");
      }
    });

    // ---------------------------------------------------------------------------------------- effects
    describe("external effects", () => {
      const seedEffect = (s: ControllerStorage) => s.applyOperation(op("fx", { effects: [{ effectId: "e1", target: "repo:main", inputDigest: DIGEST }] }));

      withStore("move forward through uncertain to a final outcome, keep the evidence, and audit every settlement", async (s) => {
        await seedEffect(s);
        await settle(s, "e1", "uncertain", undefined, 1);
        assert.equal((await s.getEffect("e1"))?.status, "uncertain");
        const result = await settle(s, "e1", "confirmed", { sha: "abc" }, 2);
        const effect = await s.getEffect("e1");
        assert.deepEqual([effect?.status, effect?.evidence, effect?.updatedAt, effect?.createdAt], ["confirmed", { sha: "abc" }, at(2), T0]);
        const audit = await s.listAudit({ afterSeq: 0, limit: 10 });
        assert.deepEqual(audit.map((a) => [a.type, a.subject, a.detail]), [
          ["effect.settled", ref("effect", "e1"), { outcome: "uncertain", previous: "intended" }],
          ["effect.settled", ref("effect", "e1"), { outcome: "confirmed", previous: "uncertain" }],
        ]);
        assert.deepEqual(result.auditSeqs, [2]);
      });

      withStore("allow a direct final outcome and make repeating it a no-op", async (s) => {
        await seedEffect(s);
        await settle(s, "e1", "failed", { why: "denied" }, 1);
        await settle(s, "e1", "failed", { why: "something else" }, 9);
        const effect = await s.getEffect("e1");
        assert.deepEqual([effect?.status, effect?.evidence, effect?.updatedAt], ["failed", { why: "denied" }, at(1)]);
      });

      withStore("refuse to contradict or reverse a final outcome, and to settle an unknown effect, leaving no audit", async (s) => {
        await seedEffect(s);
        await settle(s, "e1", "confirmed", undefined, 1);
        const before = (await s.listAudit({ afterSeq: 0, limit: 10 })).length;
        await expectKind(settle(s, "e1", "failed", undefined, 2), "state_conflict");
        await expectKind(settle(s, "e1", "uncertain", undefined, 2), "state_conflict");
        await expectKind(settle(s, "nope", "confirmed", undefined, 2), "not_found");
        assert.equal((await s.getEffect("e1"))?.status, "confirmed");
        assert.equal((await s.listAudit({ afterSeq: 0, limit: 10 })).length, before);
      });
    });

    // ----------------------------------------------------------- reconciliation in the same transaction
    describe("reconciliation committed with the domain transition", () => {
      withStore("record a receipt, fire a timer, settle an effect and move a task in one transaction", async (s) => {
        await s.applyOperation(op("seed", {
          changes: [create("task", "t1", { state: "running" })], outbox: [outbox("d1")], effects: [{ effectId: "e1", target: "x", inputDigest: DIGEST }], timers: [{ timerId: "tm1", dueAt: at(0), payload: {} }],
        }));
        const [dc] = await s.claimDeliveries({ epoch: 1, destination: "workers", claimant: "w", now: at(10), leaseMs: 100_000, limit: 5 });
        const [tc] = await s.claimDueTimers({ epoch: 1, claimant: "w", now: at(10), leaseMs: 100_000, limit: 5 });
        const handler = op("handle", {
          changes: [update("task", "t1", 1, { state: "done" })], audit: [note("task.done")],
          completeDeliveries: [{ deliveryId: "d1", claimToken: dc!.claimToken, receipt: { ok: true } }], completeTimers: [{ timerId: "tm1", claimToken: tc!.claimToken }], settleEffects: [{ effectId: "e1", outcome: "confirmed" }],
          at: at(20),
        });
        const result = await s.applyOperation(handler);
        assert.equal((await s.getAggregate(ref("task", "t1")))?.revision, 2);
        assert.deepEqual([(await s.getDelivery("d1"))?.state, (await s.getTimer("tm1"))?.state, (await s.getEffect("e1"))?.status], ["delivered", "completed", "confirmed"]);
        assert.deepEqual(result.auditSeqs, [1, 2], "the explicit audit entry comes first, then the automatic effect.settled");
        assert.equal((await s.applyOperation(handler)).replayed, true, "a crash-and-rerun of the handler is a replay");
      });

      withStore("commit none of it when any part is refused", async (s) => {
        await s.applyOperation(op("seed", { changes: [create("task", "t1", { state: "running" })], outbox: [outbox("d1")], effects: [{ effectId: "e1", target: "x", inputDigest: DIGEST }] }));
        const [dc] = await s.claimDeliveries({ epoch: 1, destination: "workers", claimant: "w", now: at(10), leaseMs: 100_000, limit: 5 });
        const refusals: [string, Partial<OperationInput>][] = [
          ["a forged delivery token", { completeDeliveries: [{ deliveryId: "d1", claimToken: "forged", receipt: {} }] }],
          ["a missing timer", { completeTimers: [{ timerId: "ghost", claimToken: "x" }] }],
          ["an unknown effect", { settleEffects: [{ effectId: "ghost", outcome: "confirmed" }] }],
        ];
        for (const [n, [name, bad]] of refusals.entries()) {
          const attempt = op(`bad-${n}`, { changes: [update("task", "t1", 1, { state: "done" })], audit: [note()], settleEffects: [{ effectId: "e1", outcome: "confirmed" }], completeDeliveries: [{ deliveryId: "d1", claimToken: dc!.claimToken, receipt: { ok: true } }], ...bad });
          const kind = await kindOf(s.applyOperation(attempt));
          assert.ok(kind === "state_conflict" || kind === "not_found", `${name}: ${kind}`);
          assert.deepEqual([(await s.getAggregate(ref("task", "t1")))?.revision, (await s.getDelivery("d1"))?.state, (await s.getEffect("e1"))?.status], [1, "claimed", "intended"], name);
          assert.equal(await s.getOperation(`bad-${n}`), undefined, name);
        }
        assert.equal((await s.listAudit({ afterSeq: 0, limit: 10 })).length, 0);
      });
    });

    // ------------------------------------------------------------------------------------------ timers
    describe("timers", () => {
      const seedTimers = (s: ControllerStorage, entries: [string, number][]) =>
        s.applyOperation(op("tm", { timers: entries.map(([timerId, ms]) => ({ timerId, dueAt: at(ms), payload: { timerId } })) }));
      const claim = (s: ControllerStorage, now: string, over: Partial<Parameters<ControllerStorage["claimDueTimers"]>[0]> = {}) =>
        s.claimDueTimers({ epoch: 1, claimant: "w1", now, leaseMs: 1000, limit: 10, ...over });

      withStore("hand out only due timers, earliest first, each to one claimant", async (s) => {
        await seedTimers(s, [["late", 5000], ["early", 1000], ["same-b", 2000], ["same-a", 2000]]);
        assert.deepEqual(await claim(s, at(500)), []);
        assert.deepEqual((await claim(s, at(2500), { leaseMs: 1_000_000 })).map((c) => c.timerId), ["early", "same-a", "same-b"]);
        assert.deepEqual(await claim(s, at(2600)), []);
        const [late] = await claim(s, at(9000));
        assert.deepEqual([late?.timerId, late?.dueAt, late?.payload, late?.attempt], ["late", at(5000), { timerId: "late" }, 1]);
      });

      withStore("hand a timer to another claimant only after the lease ends, and fence the old claim", async (s) => {
        await seedTimers(s, [["t", 0]]);
        const [first] = await claim(s, at(0), { leaseMs: 1000 });
        assert.deepEqual(await claim(s, at(999), { claimant: "w2" }), []);
        const [second] = await claim(s, at(1000), { claimant: "w2" });
        assert.equal(second?.attempt, 2);
        await expectKind(fire(s, "t", first!.claimToken, 1001), "state_conflict");
        await fire(s, "t", second!.claimToken, 1002);
        await fire(s, "t", second!.claimToken, 1003);
        assert.equal((await s.getTimer("t"))?.state, "completed");
        assert.deepEqual(await claim(s, at(100_000)), []);
        await expectKind(fire(s, "ghost", "x", 1), "not_found");
      });

      withStore("make cancellation win over a claim: the holder's completion fails as superseded", async (s) => {
        await seedTimers(s, [["t", 0]]);
        const [held] = await claim(s, at(0));
        await s.applyOperation(op("cancel", { cancelTimers: ["t"] }));
        await expectKind(fire(s, "t", held!.claimToken, 5), "state_conflict");
        assert.equal((await s.getTimer("t"))?.state, "cancelled");
      });

      withStore("cancel pending and claimed timers, tolerate unknown ones, and never fire a cancelled one", async (s) => {
        await seedTimers(s, [["a", 0], ["b", 0], ["c", 0]]);
        await claim(s, at(0), { limit: 1 });
        await s.applyOperation(op("cancel", { cancelTimers: ["a", "b", "never-existed"] }));
        assert.deepEqual([(await s.getTimer("a"))?.state, (await s.getTimer("b"))?.state, (await s.getTimer("c"))?.state], ["cancelled", "cancelled", "pending"]);
        assert.deepEqual((await claim(s, at(100_000))).map((c) => c.timerId), ["c"]);
        const [claimedLater] = await s.claimDueTimers({ epoch: 1, claimant: "w", now: at(500_000), leaseMs: 1000, limit: 5 });
        await fire(s, "c", claimedLater!.claimToken, 500_001);
        await s.applyOperation(op("cancel-done", { cancelTimers: ["c"] }));
        assert.equal((await s.getTimer("c"))?.state, "completed", "a completed timer stays completed");
      });
    });

    // -------------------------------------------------------------------------- uncertain commits and retries
    describe("retries and ambiguous commits", () => {
      const command = op("cmd", { changes: [create("task", "t1")], audit: [note()], outbox: [outbox("d1")], effects: [{ effectId: "e1", target: "x", inputDigest: DIGEST }] });
      const assertOnce = async (s: ControllerStorage) => {
        assert.equal((await s.getAggregate(ref("task", "t1")))?.revision, 1);
        assert.equal((await s.listAudit({ afterSeq: 0, limit: 10 })).length, 1);
        assert.equal((await s.getDelivery("d1"))?.seq, 1);
      };

      withStore("resolve a commit that succeeded but was reported uncertain, without admitting twice", async (s) => {
        const flaky = new FaultInjectingStorage(s, [{ when: "after", kind: "uncertain_commit" }]);
        const result = await commitOperation(flaky, command);
        assert.equal(result.replayed, true);
        assert.deepEqual(result.revisions, [{ ref: ref("task", "t1"), revision: 1 }]);
        assert.equal(flaky.calls, 1, "a resolved commit must not be submitted again");
        await assertOnce(s);
      });

      withStore("submit again when an uncertain commit turns out not to have happened", async (s) => {
        const flaky = new FaultInjectingStorage(s, [{ when: "before", kind: "uncertain_commit" }]);
        const result = await commitOperation(flaky, command);
        assert.equal(result.replayed, false);
        assert.equal(flaky.calls, 2);
        await assertOnce(s);
      });

      withStore("rerun rolled-back transactions within a bounded budget", async (s) => {
        const flaky = new FaultInjectingStorage(s, [{ when: "before", kind: "retryable" }, { when: "before", kind: "retryable" }]);
        const paused: number[] = [];
        const result = await commitOperation(flaky, command, { attempts: 3, pause: async (n) => { paused.push(n); } });
        assert.equal(result.replayed, false);
        assert.deepEqual(paused, [1, 2]);
        await assertOnce(s);

        const hopeless = new FaultInjectingStorage(s, [{ when: "before", kind: "retryable" }, { when: "before", kind: "retryable" }, { when: "before", kind: "retryable" }]);
        await expectKind(commitOperation(hopeless, op("other", { audit: [note()] }), { attempts: 3 }), "retryable");
        assert.equal(hopeless.calls, 3);
        assert.equal(await s.getOperation("other"), undefined);
      });

      withStore("not retry errors that retrying cannot fix", async (s) => {
        for (const kind of ["invalid_input", "revision_conflict", "stale_epoch", "duplicate_id", "unavailable"] as const) {
          const broken = new FaultInjectingStorage(s, [{ when: "before", kind }]);
          await expectKind(commitOperation(broken, op(`x-${kind}`, { audit: [note()] })), kind);
          assert.equal(broken.calls, 1, kind);
        }
      });

      withStore("report a conflict if an uncertain commit resolves to different content under the same ID", async (s) => {
        await s.applyOperation({ ...command, changes: [create("task", "t1", { different: true })] });
        const flaky = new FaultInjectingStorage(s, [{ when: "before", kind: "uncertain_commit" }]);
        await expectKind(commitOperation(flaky, command), "idempotency_conflict");
      });
    });

    // -------------------------------------------------------------------------------- types and representation
    describe("data types and representation", () => {
      const rejected: [string, Partial<OperationInput>][] = [
        ["empty operation ID", { operationId: "" }],
        ["operation ID with a space", { operationId: "a b" }],
        ["non-ASCII operation ID", { operationId: "café" }],
        ["201-character ID", { operationId: "a".repeat(201) }],
        ["epoch 0", { epoch: 0 }],
        ["fractional epoch", { epoch: 1.5 }],
        ["timestamp without milliseconds", { at: "2026-10-19T12:00:00Z" }],
        ["timestamp with offset", { at: "2026-10-19T12:00:00.000+02:00" }],
        ["impossible date", { at: "2026-02-30T12:00:00.000Z" }],
        ["upper-case kind", { changes: [create("Task", "t1")] }],
        ["kind starting with a digit", { changes: [create("1task", "t1")] }],
        ["update expecting revision 0", { changes: [update("task", "t1", 0, {})] }],
        ["fractional expected revision", { changes: [update("task", "t1", 1.5, {})] }],
        ["the same aggregate twice", { changes: [create("task", "t1"), create("task", "t1")] }],
        ["undefined in a body", { changes: [create("task", "t1", { a: undefined } as unknown as JsonObject)] }],
        ["NaN in a body", { changes: [create("task", "t1", { a: Number.NaN })] }],
        ["Infinity in a body", { changes: [create("task", "t1", { a: Infinity })] }],
        ["negative zero in a body", { changes: [create("task", "t1", { a: -0 })] }],
        ["integer beyond 2^53 - 1", { changes: [create("task", "t1", { a: 2 ** 53 })] }],
        ["bigint in a body", { changes: [create("task", "t1", { a: 1n } as unknown as JsonObject)] }],
        ["a Date in a body", { changes: [create("task", "t1", { a: new Date() } as unknown as JsonObject)] }],
        ["a Map in a body", { changes: [create("task", "t1", { a: new Map() } as unknown as JsonObject)] }],
        ["a function in a body", { changes: [create("task", "t1", { a: () => 1 } as unknown as JsonObject)] }],
        ["an array as a body", { changes: [create("task", "t1", [] as unknown as JsonObject)] }],
        ["a body nested too deeply", { changes: [create("task", "t1", nest(40))] }],
        ["a body that is too large", { changes: [create("task", "t1", { a: "x".repeat(300 * 1024) })] }],
        ["too many audit entries", { audit: Array.from({ length: 101 }, () => note()) }],
        ["audit detail that is not an object", { audit: [{ type: "x", detail: 5 as unknown as JsonObject }] }],
        ["outbox priority 10", { changes: [create("task", "t1")], outbox: [outbox("d1", { priority: 10 })] }],
        ["outbox priority 2.5", { changes: [create("task", "t1")], outbox: [outbox("d1", { priority: 2.5 })] }],
        ["outbox about an aggregate the operation does not touch", { changes: [create("task", "t2")], outbox: [outbox("d1")] }],
        ["the same delivery twice", { changes: [create("task", "t1")], outbox: [outbox("d1"), outbox("d1")] }],
        ["an effect digest that is not SHA-256", { effects: [{ effectId: "e1", target: "x", inputDigest: "abc" }] }],
        ["a timer due at an invalid time", { timers: [{ timerId: "tm1", dueAt: "tomorrow", payload: {} }] }],
        ["cancelling a timer the same operation creates", { timers: [{ timerId: "tm1", dueAt: at(1), payload: {} }], cancelTimers: ["tm1"] }],
        ["the same delivery completed twice", { completeDeliveries: [{ deliveryId: "d", claimToken: "t", receipt: {} }, { deliveryId: "d", claimToken: "t", receipt: {} }] }],
        ["a delivery completion without a token", { completeDeliveries: [{ deliveryId: "d", claimToken: "", receipt: {} }] }],
        ["a timer both completed and cancelled", { completeTimers: [{ timerId: "tm", claimToken: "t" }], cancelTimers: ["tm"] }],
        ["an effect settled twice", { settleEffects: [{ effectId: "e", outcome: "failed" }, { effectId: "e", outcome: "confirmed" }] }],
        ["an effect settled as intended", { settleEffects: [{ effectId: "e", outcome: "intended" as "failed" }] }],
        ["an unknown field", { surprise: 1 } as unknown as Partial<OperationInput>],
      ];
      for (const [name, over] of rejected) {
        withStore(`refuse ${name} as invalid input and write nothing`, async (s) => {
          await expectKind(s.applyOperation(op("bad", over)), "invalid_input");
          await assertNothingCommitted(s, "bad", { aggregates: [["task", "t1"]], deliveries: ["d1"], effects: ["e1"], timers: ["tm1"] });
        });
      }

      withStore("return exactly what was stored, for awkward but legal values", async (s) => {
        const body: JsonObject = {
          unicode: "café   😀 \u0000".replace("\u0000", ""), nested: { list: [1, 1.5, -2, 9007199254740991, 123456.789, 5e-7, null, true, false, "", [], {}], deeper: { n: null } },
          empty: {}, s: 1,
        } as JsonObject;
        await s.applyOperation(op("rt", { changes: [create("task", "t1", body)] }));
        assert.deepEqual((await s.getAggregate(ref("task", "t1")))?.body, body);
        const keys = ["😀", "～", "b", "a"];
        await s.applyOperation(op("order", { changes: [create("task", "t2", Object.fromEntries(keys.map((k) => [k, 1])))] }));
        assert.deepEqual(Object.keys((await s.getAggregate(ref("task", "t2")))!.body), ["a", "b", "～", "😀"], "keys come back in code-point order");
      });

      withStore("list aggregates of a kind in code-point ID order with paging", async (s) => {
        const ids = ["a2", "a10", "B1", "a1", "z"];
        await s.applyOperation(op("many", { changes: [...ids.map((id) => create("task", id)), create("project", "a0")] }));
        const first = await s.listAggregates("task", { limit: 3 });
        assert.deepEqual(first.map((a) => a.id), ["B1", "a1", "a10"]);
        assert.deepEqual((await s.listAggregates("task", { afterId: "a10", limit: 10 })).map((a) => a.id), ["a2", "z"]);
        assert.deepEqual((await s.listAggregates("project", { limit: 10 })).map((a) => a.id), ["a0"]);
      });

      withStore("return copies, and omit absent optional fields instead of reporting null", async (s) => {
        await s.applyOperation(op("c", { changes: [create("task", "t1", { list: [1], keep: null })], outbox: [outbox("d1")] }));
        const read = await s.getAggregate(ref("task", "t1"));
        (read!.body as { list: number[] }).list.push(2);
        (read as { revision: number }).revision = 99;
        assert.deepEqual((await s.getAggregate(ref("task", "t1")))?.body, { list: [1], keep: null });
        assert.equal((await s.getAggregate(ref("task", "t1")))?.revision, 1);
        const delivery = await s.getDelivery("d1");
        assert.equal("orderingKey" in (delivery ?? {}), false);
        assert.equal("claimedUntil" in (delivery ?? {}), false);
        assert.equal("receipt" in (delivery ?? {}), false);
      });

      withStore("refuse every operation once closed", async (s) => {
        await s.close();
        await expectKind(s.currentEpoch(), "unavailable");
        await expectKind(s.applyOperation(op("late", { audit: [note()] })), "unavailable");
      });
    });
  });
}

function nest(depth: number): JsonObject {
  let value: JsonObject = {};
  for (let i = 0; i < depth; i++) value = { child: value };
  return value;
}
