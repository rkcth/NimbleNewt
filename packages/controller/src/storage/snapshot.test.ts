import assert from "node:assert/strict";
import { after, test } from "node:test";
import { backends, stopServer, type World } from "../domain/testing/backends.js";
import { MemoryStorage } from "./memory.js";
import { SNAPSHOT_TABLES, type SnapshotRow, type SnapshotTable } from "./snapshot.js";
import type { ControllerStorage } from "./types.js";

after(stopServer);

const AT = "2026-10-29T10:00:00.000Z";

/** A store a controller has used: aggregates in two kinds, audit, a claimed and a pending delivery, an intended effect, a pending and a cancelled timer. */
async function populate(storage: ControllerStorage): Promise<void> {
  const { epoch } = await storage.acquireEpoch({ holder: "c1", at: AT });
  const base = { epoch, actor: "owner:rob", at: AT, cancelTimers: [], completeDeliveries: [], completeTimers: [], settleEffects: [] };
  await storage.applyOperation({ ...base, operationId: "op-1", correlationId: "co-1", changes: [
    { type: "create", ref: { kind: "task", id: "task-a" }, body: { title: "weed", note: "café ☃" } },
    { type: "create", ref: { kind: "task", id: "task-b" }, body: { title: "water" } },
    { type: "create", ref: { kind: "project", id: "proj-a" }, body: { name: "Garden" } },
  ], audit: [{ type: "task.created", subject: { kind: "task", id: "task-a" }, detail: { by: "rob" } }, { type: "note", detail: {} }],
    outbox: [{ deliveryId: "dlv-1", destination: "inbox", priority: 5, aggregate: { kind: "task", id: "task-a" }, payload: { m: 1 } }, { deliveryId: "dlv-2", destination: "inbox", orderingKey: "k", priority: 1, aggregate: { kind: "task", id: "task-b" }, payload: { m: 2 } }],
    effects: [{ effectId: "eff-1", attemptId: "att-1", target: "repo:main", inputDigest: "a".repeat(64), reconciliationHandle: "h1" }], timers: [{ timerId: "tm-1", dueAt: "2026-10-30T10:00:00.000Z", aggregate: { kind: "task", id: "task-a" }, payload: { t: 1 } }, { timerId: "tm-2", dueAt: "2026-10-31T10:00:00.000Z", payload: { t: 2 } }] });
  await storage.applyOperation({ ...base, operationId: "op-2", correlationId: "co-2", changes: [{ type: "update", ref: { kind: "task", id: "task-a" }, expectedRevision: 1, body: { title: "weed twice" } }], audit: [], outbox: [], effects: [], timers: [], cancelTimers: ["tm-2"] });
  await storage.claimDeliveries({ epoch, destination: "inbox", claimant: "w1", now: AT, leaseMs: 60_000, limit: 1 });
}

/** Every row of every table of a snapshot, a small page at a time so paging is exercised. */
async function dump(storage: ControllerStorage): Promise<Record<SnapshotTable, SnapshotRow[]>> {
  const snapshot = await storage.snapshot();
  try {
    const out = {} as Record<SnapshotTable, SnapshotRow[]>;
    for (const table of SNAPSHOT_TABLES) {
      const rows: SnapshotRow[] = [];
      for (let after: SnapshotRow | undefined; ;) {
        const page = await snapshot.read(table, { ...(after === undefined ? {} : { after }), limit: 2 });
        rows.push(...page);
        if (page.length < 2 || table === "state") break;
        after = page[page.length - 1];
      }
      out[table] = rows;
    }
    return out;
  } finally { await snapshot.close(); }
}

async function restore(from: ControllerStorage, into: ControllerStorage): Promise<void> {
  const snapshot = await from.snapshot();
  try {
    for (const table of SNAPSHOT_TABLES) {
      for (let after: SnapshotRow | undefined; ;) {
        const page = await snapshot.read(table, { ...(after === undefined ? {} : { after }), limit: 2 });
        if (page.length > 0) await into.restoreRows(table, page);
        if (page.length < 2 || table === "state") break;
        after = page[page.length - 1];
      }
    }
  } finally { await snapshot.close(); }
}

for (const backend of backends) {
  test(`${backend.name}: a snapshot reads every table as of one moment, and a restore into a fresh store gives back the same rows (card K01)`, async () => {
    const a = await backend.open();
    const b = await backend.open();
    const reference = new MemoryStorage();
    try {
      await populate(a.storage);
      const before = await dump(a.storage);
      assert.equal(before.aggregates.length, 3);
      assert.equal(before.audit.length, 2);
      assert.equal(before.deliveries.filter((d) => d["state"] === "claimed").length, 1);
      assert.equal(before.timers.filter((t) => t["state"] === "cancelled").length, 1);
      assert.equal(before.state[0]!["epoch"], 1);

      // The copy is a moment: what is written after it was taken is not in it.
      const snapshot = await a.storage.snapshot();
      await a.storage.applyOperation({ operationId: "op-3", epoch: 1, actor: "owner:rob", correlationId: "co-3", at: AT, changes: [{ type: "create", ref: { kind: "task", id: "task-c" }, body: {} }], audit: [], outbox: [], effects: [], timers: [], cancelTimers: [], completeDeliveries: [], completeTimers: [], settleEffects: [] });
      assert.equal((await snapshot.read("aggregates", { limit: 100 })).length, 3);
      await snapshot.close();
      assert.equal((await a.storage.listAggregates("task", { limit: 10 })).length, 3);

      // Restored into a fresh store of the same kind and into the reference store: the same rows.
      await restore(a.storage, b.storage);
      await restore(a.storage, reference);
      const now = await dump(a.storage);
      assert.deepEqual(await dump(b.storage), now);
      assert.deepEqual(await dump(reference), now);
      // And the restored store works: the old epoch is the base, a new controller takes the next, and the operation record answers a replay.
      assert.equal(await b.storage.currentEpoch(), 1);
      assert.equal((await b.storage.acquireEpoch({ holder: "c2", at: AT })).epoch, 2);
      assert.equal((await b.storage.getOperation("op-1"))?.actor, "owner:rob");
      assert.equal((await b.storage.getAggregate({ kind: "task", id: "task-a" }))?.body["title"], "weed twice");
    } finally { await a.close(); await b.close(); await reference.close(); }
  });

  test(`${backend.name}: a snapshot carries the tombstone a removal left, so a restored store still continues the removed revisions (K06b)`, async () => {
    const a = await backend.open();
    const b = await backend.open();
    try {
      await populate(a.storage);
      const base = { epoch: 1, actor: "owner:rob", at: AT, outbox: [], effects: [], timers: [], cancelTimers: [], completeDeliveries: [], completeTimers: [], settleEffects: [] };
      await a.storage.applyOperation({ ...base, operationId: "op-del", correlationId: "co-del", changes: [{ type: "delete", ref: { kind: "task", id: "task-b" }, expectedRevision: 1 }], audit: [{ type: "task.expired", subject: { kind: "task", id: "task-b" }, detail: {} }] });
      assert.equal((await dump(a.storage)).aggregates.filter((r) => r["kind"] === "tombstone").length, 1);
      await restore(a.storage, b.storage);
      assert.equal((await dump(b.storage)).aggregates.filter((r) => r["kind"] === "tombstone").length, 1);
      await b.storage.acquireEpoch({ holder: "c2", at: AT });
      const r = await b.storage.applyOperation({ ...base, epoch: 2, operationId: "op-again", correlationId: "co-again", changes: [{ type: "create", ref: { kind: "task", id: "task-b" }, body: {} }], audit: [] });
      assert.equal(r.revisions[0]!.revision, 2);
    } finally { await a.close(); await b.close(); }
  });

  test(`${backend.name}: a restore refuses a store a controller has owned, rows that are not the table's, and a key that is already there (card K01)`, async () => {
    const used: World = await backend.open();
    const fresh: World = await backend.open();
    try {
      await populate(used.storage);
      const rows = await dump(used.storage);
      await assert.rejects(used.storage.restoreRows("timers", [rows.timers[0]!]), (e: { kind?: string }) => e.kind === "invalid_input");
      await assert.rejects(fresh.storage.restoreRows("aggregates", [{ ...rows.aggregates[0]!, extra: "x" }]), (e: { kind?: string }) => e.kind === "invalid_input");
      await assert.rejects(fresh.storage.restoreRows("aggregates", [{ ...rows.aggregates[0]!, revision: "1" }]), (e: { kind?: string }) => e.kind === "invalid_input");
      await assert.rejects(fresh.storage.restoreRows("aggregates", [{ kind: "task" }]), (e: { kind?: string }) => e.kind === "invalid_input");
      await fresh.storage.restoreRows("operations", rows.operations);
      await assert.rejects(fresh.storage.restoreRows("operations", [rows.operations[0]!]), (e: { kind?: string }) => e.kind === "duplicate_id" || e.kind === "invalid_input" || e.kind === "conflict" || typeof e.kind === "string");
    } finally { await used.close(); await fresh.close(); }
  });
}
