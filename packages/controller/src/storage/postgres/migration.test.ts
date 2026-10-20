import assert from "node:assert/strict";
import { after, test } from "node:test";
import { StorageError } from "../errors.js";
import { registry } from "../qualification/migration-registry.js";
import {
  cannotLoopForever, concurrentOpensApplyOnce, refusals, resumesRunningMigrations, upgradeCrashMatrix, upgradePreservesState, type Description, type MigrationOutcome, type MigrationRig, type MigrationWorld,
} from "../qualification/migrations-suite.js";
import { PostgresStorage } from "./index.js";
import { FaultProxy } from "./testing/proxy.js";
import { startTestServer, withClient, type TestServer } from "./testing/server.js";

let serverPromise: Promise<TestServer> | undefined;
const server = (): Promise<TestServer> => (serverPromise ??= startTestServer());
after(async () => { if (serverPromise !== undefined) await (await serverPromise).stop(); });

let counter = 0;

const rig: MigrationRig = {
  name: "postgres",
  dialect: "postgres",
  open: async () => {
    const s = await server();
    const real = new URL(s.url());
    const schema = `mig_${process.pid}_${counter++}`;
    const proxy = await FaultProxy.start({ host: real.hostname, port: Number(real.port) });
    const proxied = new URL(real); proxied.port = String(proxy.port);
    const open = (url: string, migrations: Parameters<typeof registry>[1]) => PostgresStorage.open({ connectionString: url, schema, maxConnections: 2, migrations: registry("postgres", migrations) });
    const outcomeOf = async (migrations: Parameters<typeof registry>[1], point?: { when: "before" | "after"; ordinal: number }): Promise<MigrationOutcome> => {
      proxy.arm(point);
      try {
        const storage = await open(proxied.toString(), migrations);
        await storage.close();
        // A cut that lands on the cleanup after the last migration does not fail the open (the schema is done); it still counts as reached.
        return { crashed: point !== undefined && proxy.fired > 0, statements: proxy.statements };
      } catch (error) {
        if (point !== undefined && proxy.fired > 0) return { crashed: true, statements: proxy.statements };
        if (error instanceof StorageError) return { crashed: false, statements: proxy.statements, error };
        throw error;
      }
    };
    const world: MigrationWorld = {
      attempt: outcomeOf,
      withStorage: async (migrations, fn) => {
        const storage = await open(s.url(), migrations);
        try { return await fn(storage); } finally { await storage.close(); }
      },
      describe: async (): Promise<Description> => withClient(s.url(), async (c) => {
        const has = async (table: string) => (await c.query("SELECT to_regclass($1) AS t", [`${schema}.${table}`])).rows[0]!.t !== null;
        const columns = (await c.query("SELECT table_name, column_name, data_type, collation_name, is_nullable FROM information_schema.columns WHERE table_schema = $1 ORDER BY table_name, ordinal_position", [schema])).rows;
        const indexes = (await c.query("SELECT indexname, replace(indexdef, $2, '<schema>') AS indexdef FROM pg_indexes WHERE schemaname = $1 ORDER BY indexname", [schema, schema])).rows;
        return {
          structure: { columns, indexes },
          journal: (await has("schema_migrations")) ? (await c.query(`SELECT version, name, state FROM ${schema}.schema_migrations ORDER BY version`)).rows.map((r) => ({ version: r.version as number, name: r.name as string, state: r.state as string })) : [],
          probe: (await has("migration_probe")) ? (await c.query(`SELECT n FROM ${schema}.migration_probe ORDER BY n`)).rows.map((r) => r.n as number) : [],
        };
      }),
      sql: async (statement) => { await withClient(s.url(), async (c) => { await c.query(`SET search_path = ${schema}`); await c.query(statement); }); },
      attemptTwice: async (migrations) => {
        const both = await Promise.all([outcomeOf(migrations), outcomeOf(migrations)]);
        return both;
      },
      close: async () => {
        await proxy.stop();
        await withClient(s.url(), async (c) => { await c.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`); });
      },
    };
    return world;
  },
};

test("PostgreSQL: an upgrade preserves a populated database and the adapter keeps working on the new layout", () => upgradePreservesState(rig));
test("PostgreSQL: a database from a newer version, an edited migration and a journal gap are refused and left untouched", () => refusals(rig));
test("PostgreSQL: an interrupted non-transactional migration is finished by the next start; a running entry with different content is refused", () => resumesRunningMigrations(rig));
test("PostgreSQL: two openers at once apply each migration exactly once", () => concurrentOpensApplyOnce(rig));
test("PostgreSQL: an upgrade cut before or after every statement leaves a recoverable database, never half a migration, and recovery reaches the uninterrupted state", async (t) => {
  const report = await upgradeCrashMatrix(rig);
  t.diagnostic(`upgrade crash matrix: ${report.statements} statements, ${report.points} crash points`);
  assert.ok(report.points >= 30);
});

test("PostgreSQL: a migration that cannot be journaled stops the runner with an error instead of repeating forever", { timeout: 90_000 }, () => cannotLoopForever(rig));
