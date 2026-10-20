import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { after, test } from "node:test";
import { FIXTURE_DIRECTORY, type PostgresFixture } from "../qualification/fixtures.js";
import { registry } from "../qualification/migration-registry.js";
import { snapshotWorld } from "../qualification/boundaries.js";
import { LATEST_VERSION, MIGRATIONS, PostgresStorage } from "./index.js";
import { startTestServer, withClient, type TestServer } from "./testing/server.js";

let serverPromise: Promise<TestServer> | undefined;
const server = (): Promise<TestServer> => (serverPromise ??= startTestServer());
after(async () => { if (serverPromise !== undefined) await (await serverPromise).stop(); });

const fixture = JSON.parse(readFileSync(join(FIXTURE_DIRECTORY, "layout-1.postgres.json"), "utf8")) as PostgresFixture;
const expected = JSON.parse(readFileSync(join(FIXTURE_DIRECTORY, "layout-1.snapshot.json"), "utf8")) as unknown;

test("the committed layout-1 schema opens with this build, reports exactly its recorded state, and upgrades without losing any of it", async () => {
  const s = await server();
  const schema = `fx_${process.pid}`;
  try {
    await withClient(s.url(), async (c) => {
      await c.query(`CREATE SCHEMA ${schema}`);
      await c.query(`SET search_path = ${schema}`);
      for (const statement of fixture.ddl) await c.query(statement);
      for (const [table, rows] of Object.entries(fixture.rows)) {
        if (table === "state" || table === "counters") await c.query(`DELETE FROM ${table}`); // the DDL seeds one empty row of each; the fixture has the real ones
        for (const row of rows) {
          const columns = Object.keys(row);
          await c.query(`INSERT INTO ${table} (${columns.join(", ")}) VALUES (${columns.map((_, i) => `$${i + 1}`).join(", ")})`, columns.map((k) => row[k]));
        }
      }
    });
    // The fixture's DDL is a frozen copy of migration 1; this build's migration 1 must still be that text.
    assert.deepEqual(fixture.ddl.slice(1), MIGRATIONS[0]!.statements);
    const current = await PostgresStorage.open({ connectionString: s.url(), schema });
    assert.equal((await current.settings()).schemaVersion, LATEST_VERSION);
    assert.deepEqual(await snapshotWorld(current), expected);
    await current.close();
    const upgraded = await PostgresStorage.open({ connectionString: s.url(), schema, migrations: registry("postgres", "v123") });
    assert.equal((await upgraded.settings()).schemaVersion, 3);
    assert.deepEqual(await snapshotWorld(upgraded), expected);
    await upgraded.close();
  } finally {
    await withClient(s.url(), async (c) => { await c.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`); });
  }
});
