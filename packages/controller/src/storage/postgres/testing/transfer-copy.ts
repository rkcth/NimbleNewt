import { commitWhileWaiting, withClient } from "./server.js";

/**
 * SQL the database transfer tests need around a destination schema (card F04l): things someone else does to it while a copy runs, and reads of what is left.
 * They live here because only the storage folders may hold SQL. Schema names come from the tests themselves.
 */

/** Something else made in or around the schema of a copy in progress. */
export type ForeignChange = "view-elsewhere" | "table-inside" | "foreign-holder" | "epoch-taken";

/** Makes `change` to `schema`; `other` is the second schema a view elsewhere goes in. */
export async function makeForeignChange(url: string, schema: string, other: string, change: ForeignChange): Promise<void> {
  const statements = {
    "view-elsewhere": [`CREATE SCHEMA ${other}`, `CREATE VIEW ${other}.watching AS SELECT version FROM ${schema}.schema_migrations`],
    "table-inside": [`CREATE TABLE ${schema}.owners_notes (n int)`, `INSERT INTO ${schema}.owners_notes VALUES (7)`],
    "foreign-holder": [`UPDATE ${schema}.state SET holder = 'transfer-pending:xfer-someone-else'`],
    "epoch-taken": [`UPDATE ${schema}.state SET epoch = 4`],
  }[change];
  await withClient(url, async (c) => { for (const s of statements) await c.query(s); });
}

/** Whether what `change` made is still there, as it was made. */
export async function foreignChangeSurvives(url: string, schema: string, other: string, change: ForeignChange): Promise<boolean> {
  return withClient(url, async (c) => {
    switch (change) {
      case "view-elsewhere": return (await c.query("SELECT to_regclass($1)::text AS t", [`${other}.watching`])).rows[0]?.t === `${other}.watching`;
      case "table-inside": return (await c.query(`SELECT n FROM ${schema}.owners_notes`)).rows[0]?.n === 7;
      case "foreign-holder": return (await c.query(`SELECT holder FROM ${schema}.state`)).rows[0]?.holder === "transfer-pending:xfer-someone-else";
      case "epoch-taken": return (await c.query(`SELECT epoch::int AS e FROM ${schema}.state`)).rows[0]?.e === 4;
    }
  });
}

/** The holder in the schema's state row (null when none). */
export async function stateHolder(url: string, schema: string): Promise<string | null> {
  return withClient(url, async (c) => ((await c.query(`SELECT holder FROM ${schema}.state`)).rows[0]?.holder ?? null) as string | null);
}

/** How many rows the table holds. */
export async function tableRows(url: string, schema: string, table: string): Promise<number> {
  return withClient(url, async (c) => Number((await c.query(`SELECT count(*)::int AS n FROM ${schema}.${table}`)).rows[0]?.n));
}

/** The names of the tables in the schema, sorted (for checking `CONTROLLER_TABLES` against what an open really makes). */
export async function schemaTables(url: string, schema: string): Promise<string[]> {
  return withClient(url, async (c) => (await c.query("SELECT tablename FROM pg_tables WHERE schemaname = $1 ORDER BY tablename COLLATE \"C\"", [schema])).rows.map((r: { tablename: string }) => r.tablename));
}

/**
 * A second copy's race with a clean-up: in a transaction left open, the schema's state row is given `epoch` and `holder` (as another copy's final write would);
 * `start()` runs with that row locked; once a session named `application` waits on a lock (in any statement), the transaction commits. Returns what `start()` settles to.
 */
export async function commitStateRowWhileWaiting<T>(url: string, schema: string, epoch: number, holder: string, application: string, start: () => Promise<T>): Promise<T> {
  return commitWhileWaiting(url, [`UPDATE ${schema}.state SET epoch = ${String(Math.trunc(epoch))}, holder = '${holder.replace(/'/g, "''")}'`], application, "", start);
}
