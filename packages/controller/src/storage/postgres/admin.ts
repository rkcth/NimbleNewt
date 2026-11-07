/**
 * Server-side reads and clean-up a database transfer needs on a PostgreSQL destination (card F04l). They live here because only the storage folders may touch the database driver.
 * Each opens a short-lived connection to the address it is given and closes it; errors are the driver's own and may name the server, so callers hide the address before showing them.
 */

const SCHEMA_NAME = /^[a-z][a-z0-9_]{0,40}$/;

async function withClient<T>(connectionString: string, work: (client: import("pg").Client) => Promise<T>): Promise<T> {
  const { default: pg } = await import("pg");
  const client = new pg.Client({ connectionString, connectionTimeoutMillis: 10_000, statement_timeout: 30_000 });
  await client.connect();
  try { return await work(client); } finally { await client.end().catch(() => undefined); }
}

/** The size in bytes the server reports for the whole database the address names (all its schemas, indexes and TOAST data). */
export async function postgresDatabaseBytes(connectionString: string): Promise<number> {
  return withClient(connectionString, async (c) => {
    const n = Number((await c.query("SELECT pg_database_size(current_database())::text AS n")).rows[0]?.n);
    if (!Number.isFinite(n) || n < 0) throw new Error("the server did not report a database size");
    return n;
  });
}

/** Empties a destination after a failed copy: drops the schema and everything in it. The name is checked against the same rule the storage uses, so it can be placed in the statement. */
export async function dropPostgresSchema(connectionString: string, schema: string): Promise<void> {
  if (!SCHEMA_NAME.test(schema)) throw new Error("invalid PostgreSQL schema name");
  await withClient(connectionString, async (c) => { await c.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`); });
}
