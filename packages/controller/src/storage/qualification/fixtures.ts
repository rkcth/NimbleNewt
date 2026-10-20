import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { PostgresStorage } from "../postgres/index.js";
import { JOURNAL_SQL as PG_JOURNAL, MIGRATIONS as PG_MIGRATIONS } from "../postgres/schema.js";
import { startEmbeddedServer } from "../postgres/testing/server.js";
import { SqliteStorage } from "../sqlite/index.js";
import { ACTIONS, seedWorld, snapshotWorld } from "./boundaries.js";
import { DatabaseSync } from "node:sqlite";

/**
 * Layout-1 fixtures: a populated controller database exactly as this layout wrote it, kept in the repository so that every later
 * build must still open it (the journal records migration 1's checksum, so editing migration 1 breaks it, as it should) and upgrade
 * it without losing anything. Regenerate only if layout 1's contents are deliberately changed before it ships:
 *   node dist/storage/qualification/fixtures.js
 * Files (in packages/controller/test-fixtures/):
 *   layout-1.sqlite          the SQLite database file (checkpointed, no -wal)
 *   layout-1.postgres.json   the PostgreSQL schema as DDL statements plus every row, as plain JSON
 *   layout-1.snapshot.json   what the storage reports for the populated world, for comparison after opening or upgrading
 */
export const FIXTURE_DIRECTORY = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "test-fixtures");

const TABLES = ["state", "counters", "operations", "aggregates", "audit", "deliveries", "effects", "timers", "schema_migrations"] as const;

export interface PostgresFixture { readonly ddl: readonly string[]; readonly rows: Readonly<Record<string, readonly Record<string, unknown>[]>> }

async function populate(open: () => Promise<{ storage: import("../types.js").ControllerStorage; close(): Promise<void> }>): Promise<unknown> {
  const { storage, close } = await open();
  try {
    await seedWorld(storage);
    await ACTIONS.operation.run(storage);
    return await snapshotWorld(storage);
  } finally { await close(); }
}

export async function generate(directory: string = FIXTURE_DIRECTORY): Promise<void> {
  mkdirSync(directory, { recursive: true });
  const work = join(directory, ".generating");
  rmSync(work, { recursive: true, force: true });
  mkdirSync(work, { recursive: true });
  try {
    // SQLite: build with this layout, then fold the write-ahead log into the one file.
    const sqlitePath = join(work, "layout-1.sqlite");
    const snapshot = await populate(async () => { const storage = await SqliteStorage.open({ path: sqlitePath }); return { storage, close: () => storage.close() }; });
    const raw = new DatabaseSync(sqlitePath);
    raw.exec("PRAGMA wal_checkpoint(TRUNCATE)");
    raw.close();
    writeFileSync(join(directory, "layout-1.sqlite"), await import("node:fs").then((fs) => fs.readFileSync(sqlitePath)));

    // PostgreSQL: build with this layout in a throwaway server and read every row back.
    const server = await startEmbeddedServer([], work);
    try {
      const schema = "fixture";
      const postgresSnapshot = await populate(async () => { const storage = await PostgresStorage.open({ connectionString: server.url(), schema }); return { storage, close: () => storage.close() }; });
      if (JSON.stringify(postgresSnapshot) !== JSON.stringify(snapshot)) throw new Error("the SQLite and PostgreSQL fixtures disagree about the populated world; they must describe the same state");
      const client = new pg.Client({ connectionString: server.url() });
      await client.connect();
      try {
        const rows: Record<string, Record<string, unknown>[]> = {};
        for (const table of TABLES) rows[table] = (await client.query(`SELECT * FROM ${schema}.${table} ORDER BY 1, 2`.replace(" ORDER BY 1, 2", table === "state" || table === "counters" ? "" : " ORDER BY 1"))).rows.map((r) => ({ ...r }));
        const fixture: PostgresFixture = { ddl: [PG_JOURNAL, ...PG_MIGRATIONS[0]!.statements], rows };
        writeFileSync(join(directory, "layout-1.postgres.json"), `${JSON.stringify(fixture, null, 2)}\n`);
      } finally { await client.end(); }
    } finally { await server.stop(); }
    writeFileSync(join(directory, "layout-1.snapshot.json"), `${JSON.stringify(snapshot, null, 2)}\n`);
  } finally { rmSync(work, { recursive: true, force: true }); }
}

if (process.argv[1]?.endsWith("fixtures.js")) await generate();
