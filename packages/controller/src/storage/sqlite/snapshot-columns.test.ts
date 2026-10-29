import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { registry } from "../qualification/migration-registry.js";
import { SqliteStorage } from "./index.js";

const AT = "2026-10-29T10:00:00.000Z";
async function populate(storage: SqliteStorage): Promise<void> {
  const { epoch } = await storage.acquireEpoch({ holder: "c1", at: AT });
  await storage.applyOperation({ operationId: "op-1", epoch, actor: "owner:rob", correlationId: "co-1", at: AT, changes: [{ type: "create", ref: { kind: "task", id: "task-a" }, body: { title: "weed" } }], audit: [], outbox: [], effects: [{ effectId: "eff-1", target: "repo:main", inputDigest: "a".repeat(64) }, { effectId: "eff-2", target: "repo:other", inputDigest: "b".repeat(64) }], timers: [], cancelTimers: [], completeDeliveries: [], completeTimers: [], settleEffects: [] });
}

test("a snapshot of a database from an older layout reads the columns it has (card K01)", async () => {
  const dir = mkdtempSync(join(tmpdir(), "nn-upg-cols-"));
  try {
    const path = join(dir, "c.sqlite");
    let store = await SqliteStorage.open({ path });
    await populate(store);
    await store.close();
    const db = new DatabaseSync(path);
    db.exec("ALTER TABLE effects DROP COLUMN reconciliation_handle");
    db.close();
    store = await SqliteStorage.open({ path, migrations: registry("sqlite", "v1") });
    const snapshot = await store.snapshot();
    try {
      const rows = await snapshot.read("effects", { limit: 10 });
      assert.equal(rows.length, 2);
      assert.equal("reconciliation_handle" in rows[0]!, false, "the column this layout lacks is absent");
      assert.equal(rows[0]!["effect_id"], "eff-1");
    } finally { await snapshot.close(); await store.close(); }
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("the snapshot copy runs off the event loop: the caller's loop turns while the copy is still being made (card K01f)", async () => {
  const dir = mkdtempSync(join(tmpdir(), "nn-snap-loop-"));
  try {
    const store = await SqliteStorage.open({ path: join(dir, "c.sqlite") });
    await populate(store);
    let settled = false;
    const made = store.snapshot().then((s) => { settled = true; return s; });
    await new Promise((r) => setImmediate(r));
    assert.equal(settled, false, "the copy was not finished by the time the event loop turned once");
    const snapshot = await made;
    try { assert.equal((await snapshot.read("aggregates", { limit: 10 })).length, 1); } finally { await snapshot.close(); await store.close(); }
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
