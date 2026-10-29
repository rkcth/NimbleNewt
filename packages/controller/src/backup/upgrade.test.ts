import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { PostgresStorage } from "../storage/postgres/index.js";
import { startTestServer, withClient, type TestServer } from "../storage/postgres/testing/server.js";
import { registry } from "../storage/qualification/migration-registry.js";
import { SqliteStorage } from "../storage/sqlite/index.js";
import type { BeforeUpgrade, ControllerStorage } from "../storage/index.js";
import { createBackup, listBackups, verifyBackup } from "./index.js";

let server: Promise<TestServer> | undefined;
after(async () => { if (server !== undefined) await (await server).stop(); });

const AT = "2026-10-29T10:00:00.000Z";
async function populate(storage: ControllerStorage): Promise<void> {
  const { epoch } = await storage.acquireEpoch({ holder: "c1", at: AT });
  await storage.applyOperation({ operationId: "op-1", epoch, actor: "owner:rob", correlationId: "co-1", at: AT, changes: [{ type: "create", ref: { kind: "task", id: "task-a" }, body: { title: "weed" } }], audit: [], outbox: [], effects: [{ effectId: "eff-1", target: "repo:main", inputDigest: "a".repeat(64) }, { effectId: "eff-2", target: "repo:other", inputDigest: "b".repeat(64) }], timers: [], cancelTimers: [], completeDeliveries: [], completeTimers: [], settleEffects: [] });
}

/** The same sequence on both backends: a v1 database, upgraded to v2 with the hook taking a pre-upgrade backup first. */
async function scenario(open: (migrations: "v1" | "v12", hook?: BeforeUpgrade) => Promise<ControllerStorage & { settings(): { schemaVersion: number } | Promise<{ schemaVersion: number }> }>): Promise<void> {
  const root = mkdtempSync(join(tmpdir(), "nn-upg-"));
  try {
    // A new database is never announced: there is nothing to keep.
    let calls: { from: number; to: number }[] = [];
    const keep: BeforeUpgrade = async (n) => { calls.push({ from: n.from, to: n.to }); await createBackup({ snapshot: n.snapshot }, { root, kind: "pre-upgrade", version: "t", now: () => new Date(AT) }); };
    let store = await open("v1", keep);
    assert.deepEqual(calls, []);
    await populate(store);
    await store.close();

    // A hook that fails stops the upgrade: the database is still on version 1 and opens as it was.
    store = await open("v12", async () => { throw new Error("no room for the backup"); }).catch((e) => e as Error) as never;
    assert.match(String((store as unknown as Error).message), /no room for the backup/);
    store = await open("v1");
    assert.equal((await store.settings()).schemaVersion, 1);
    await store.close();

    // The upgrade is announced once, with the old database in the snapshot, and then goes ahead.
    store = await open("v12", keep);
    assert.deepEqual(calls, [{ from: 1, to: 2 }]);
    assert.equal((await store.settings()).schemaVersion, 2);
    const [backup] = await listBackups(root);
    assert.equal(backup!.manifest.kind, "pre-upgrade");
    assert.equal(backup!.manifest.schemaVersion, 1, "the copy is of the database as it was before the upgrade");
    assert.equal(backup!.manifest.files.find((f) => f.table === "aggregates")!.rows, 1);
    assert.equal((await verifyBackup(backup!.path)).ok, true);
    await store.close();

    // Opened again at the same version, nothing is announced.
    calls = [];
    store = await open("v12", keep);
    assert.deepEqual(calls, []);
    await store.close();
  } finally { rmSync(root, { recursive: true, force: true }); }
}

test("SQLite: an upgrade of an existing database is announced with a snapshot first; a failing hook stops it (card K01)", async () => {
  const dir = mkdtempSync(join(tmpdir(), "nn-upg-db-"));
  try { await scenario((migrations, hook) => SqliteStorage.open({ path: join(dir, "c.sqlite"), migrations: registry("sqlite", migrations), ...(hook === undefined ? {} : { beforeUpgrade: hook }) })); } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("PostgreSQL: an upgrade of an existing database is announced with a snapshot first; a failing hook stops it (card K01)", async () => {
  server ??= startTestServer();
  const s = await server;
  const schema = `upg_${process.pid}_${Math.random().toString(36).slice(2, 8)}`;
  try { await scenario((migrations, hook) => PostgresStorage.open({ connectionString: s.url(), schema, migrations: registry("postgres", migrations), ...(hook === undefined ? {} : { beforeUpgrade: hook }) })); }
  finally { await withClient(s.url(), async (c) => { await c.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`); }); }
});

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
