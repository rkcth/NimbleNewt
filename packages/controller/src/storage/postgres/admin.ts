/**
 * Server-side reads and clean-up a database transfer needs on a PostgreSQL destination (card F04l). They live here because only the storage folders may touch the database driver.
 * Each opens a short-lived connection to the address it is given and closes it; errors are the driver's own and may name the server, so callers hide the address before showing them.
 */

import { CONTROLLER_TABLES } from "./schema.js";

const SCHEMA_NAME = /^[a-z][a-z0-9_]{0,40}$/;

async function withClient<T>(connectionString: string, work: (client: import("pg").Client) => Promise<T>): Promise<T> {
  const { default: pg } = await import("pg");
  const client = new pg.Client({ connectionString, connectionTimeoutMillis: 10_000, statement_timeout: 30_000 });
  await client.connect();
  try { return await work(client); } finally { await client.end().catch(() => undefined); }
}

/** The size in bytes the server reports for the whole database the address names (all its schemas, indexes and TOAST data). */
export async function postgresDatabaseBytes(connectionString: string): Promise<number> {
  return withClient(connectionString, async (c) => databaseSizeFrom((await c.query("SELECT pg_database_size(current_database())::text AS n")).rows[0]?.n));
}

/** The server's size answer as a number of bytes; anything that is not a whole, non-negative number is an error (a NaN would make every room check pass). */
export function databaseSizeFrom(answer: unknown): number {
  const n = typeof answer === "string" && /^\d+$/.test(answer) ? Number(answer) : Number.NaN;
  if (!Number.isFinite(n) || n < 0) throw new Error("the server did not report a database size");
  return n;
}

/**
 * Empties a destination after a failed copy (card F04l), never with CASCADE. In one transaction: the schema's `state` row is locked and must still be the open's own
 * (holder NULL at epoch 0: the copy failed before the state row, which is copied last) or carry `pendingHolder` (this transfer's own copy); then the controller tables
 * (the migration journal and every table the migrations create) are dropped RESTRICT, and the schema RESTRICT. Anything else in the schema, or anything outside it that
 * depends on those tables (a view, a foreign key), makes a drop fail and the whole transaction rolls back: nothing is dropped and the caller reports the destination
 * as not clean. A schema that is already gone is a success (a re-run after a drop). The name is checked against the storage's rule, so it can be placed in the statements.
 */
export async function discardPostgresTransferCopy(connectionString: string, schema: string, pendingHolder: string): Promise<void> {
  if (!SCHEMA_NAME.test(schema)) throw new Error("invalid PostgreSQL schema name");
  await withClient(connectionString, async (c) => {
    await c.query("BEGIN");
    try {
      if ((await c.query("SELECT 1 AS x FROM pg_namespace WHERE nspname = $1", [schema])).rows.length === 0) { await c.query("COMMIT"); return; }
      if ((await c.query("SELECT to_regclass($1)::text AS t", [`${schema}.state`])).rows[0]?.t == null) throw new Error(`the schema ${schema} has no controller state table, so what is in it is not known to be this transfer's copy; nothing was dropped`);
      // FOR UPDATE: a concurrent copy's state row waits for this transaction (and then finds the table gone), or committed first and is seen here.
      const row = (await c.query(`SELECT epoch::text AS epoch, holder FROM ${schema}.state WHERE singleton = 1 FOR UPDATE`)).rows[0] as { epoch: string; holder: string | null } | undefined;
      const ours = row !== undefined && (row.holder === pendingHolder || (row.holder === null && row.epoch === "0"));
      if (!ours) throw new Error(`the schema ${schema} now holds another copy or a database in use (its state row is not this transfer's), so nothing was dropped`);
      try {
        await c.query(`DROP TABLE IF EXISTS ${CONTROLLER_TABLES.map((t) => `${schema}.${t}`).join(", ")} RESTRICT`);
        await c.query(`DROP SCHEMA ${schema} RESTRICT`);
      } catch (error) {
        throw new Error(`the schema ${schema} holds, or is depended on by, objects the transfer did not create, so nothing was dropped (${error instanceof Error ? error.message.slice(0, 200) : "refused"})`);
      }
      await c.query("COMMIT");
    } catch (error) {
      await c.query("ROLLBACK").catch(() => undefined);
      throw error;
    }
  });
}

/** Drops a schema and everything in it (CASCADE). For tests' clean-up only: a transfer never uses it (see `discardPostgresTransferCopy`). */
export async function dropPostgresSchema(connectionString: string, schema: string): Promise<void> {
  if (!SCHEMA_NAME.test(schema)) throw new Error("invalid PostgreSQL schema name");
  await withClient(connectionString, async (c) => { await c.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`); });
}

/** Whether the schema exists on the server (for checks that a failed copy was cleaned up). */
export async function postgresSchemaExists(connectionString: string, schema: string): Promise<boolean> {
  return withClient(connectionString, async (c) => Number((await c.query("SELECT count(*)::int AS n FROM information_schema.schemata WHERE schema_name = $1", [schema])).rows[0]?.n) > 0);
}
