import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { SqliteStorage } from "./index.js";
import { makeForeignDatabase, storeDigest } from "./testing/raw-db.js";

// Card G08 review: the outside reader's digest (`storeDigest`) is what the recovery-policy exercise relies on to say "nothing reached the store". It must see a change that keeps the number of rows (a value rewritten in place), a change in
// any store table, and a table the schema list does not name; and it must not be taken for a proof when pointed at a file that is not a store.

const AT = "2026-11-27T10:00:00.000Z";

test("the store digest sees a value rewritten in place in each table that holds rows, a row added to a table it does not name, and refuses a file that is not a controller store (card G08 review)", async () => {
  const dir = mkdtempSync(join(tmpdir(), "nn-digest-"));
  try {
    const path = join(dir, "c.sqlite");
    const store = await SqliteStorage.open({ path });
    const { epoch } = await store.acquireEpoch({ holder: "c1", at: AT });
    await store.applyOperation({ operationId: "op-1", epoch, actor: "owner:rob", correlationId: "co-1", at: AT, changes: [{ type: "create", ref: { kind: "task", id: "task-a" }, body: { title: "weed" } }], audit: [], outbox: [], effects: [{ effectId: "eff-1", target: "repo:main", inputDigest: "a".repeat(64) }], timers: [], cancelTimers: [], completeDeliveries: [], completeTimers: [], settleEffects: [] });
    await store.close();

    const base = storeDigest(path);
    assert.deepEqual(storeDigest(path), base, "two reads of an unchanged file agree");
    for (const t of ["state", "aggregates", "operations", "audit", "deliveries", "effects", "timers"]) assert.ok(base.tables.includes(t), t);

    // Each rewrite keeps the row count; each is undone before the next, so each is seen on its own.
    const rewrites: readonly (readonly [string, string, string])[] = [
      ["state", "UPDATE state SET holder = 'someone-else'", "UPDATE state SET holder = 'c1'"],
      ["aggregates", "UPDATE aggregates SET body = '{\"title\":\"weeds\"}' WHERE id = 'task-a'", "UPDATE aggregates SET body = '{\"title\":\"weed\"}' WHERE id = 'task-a'"],
      ["operations", "UPDATE operations SET actor = 'owner:ann' WHERE operation_id = 'op-1'", "UPDATE operations SET actor = 'owner:rob' WHERE operation_id = 'op-1'"],
      ["effects", "UPDATE effects SET target = 'repo:other' WHERE effect_id = 'eff-1'", "UPDATE effects SET target = 'repo:main' WHERE effect_id = 'eff-1'"],
    ];
    for (const [table, change, undo] of rewrites) {
      const db = new DatabaseSync(path);
      try {
        db.exec(change);
        const changed = storeDigest(path);
        assert.equal(changed.rows, base.rows, `${table}: the same number of rows`);
        assert.notEqual(changed.digest, base.digest, `${table}: a value rewritten in place is seen`);
        db.exec(undo);
      } finally { db.close(); }
      assert.equal(storeDigest(path).digest, base.digest, `${table}: undone`);
    }

    const db = new DatabaseSync(path);
    try { db.exec("CREATE TABLE \"later one\" (x); INSERT INTO \"later one\" VALUES (1)"); } finally { db.close(); }
    const extra = storeDigest(path);
    assert.ok(extra.tables.includes("later one"));
    assert.notEqual(extra.digest, base.digest, "a table the list does not name is covered too");

    const foreign = join(dir, "other.sqlite");
    makeForeignDatabase(foreign);
    assert.throws(() => storeDigest(foreign), /not a controller store/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
