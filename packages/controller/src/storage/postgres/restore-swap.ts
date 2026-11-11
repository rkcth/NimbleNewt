/**
 * The server-side half of a staged restore on PostgreSQL (card K01i). A running controller owns its schema, so a restore is written into a NEW schema of the same database (`stagedSchemaOf`) and swapped in at the next start,
 * before the storage is opened: in ONE transaction the live schema is renamed aside (`asideSchemaOf`) and the staged one takes its name. A schema rename moves every table, index and constraint with it (the controller's
 * schema holds no functions or views that name it), so the swap is all or nothing, and it is undone the same way. Nothing is dropped except a staged schema this restore made (cancel, or a failed prepare).
 * It lives here because only the storage folders may touch the database driver. Each call opens a short-lived connection and closes it; the address is never put in a message.
 */

import { createHash } from "node:crypto";
import { withShortConnection } from "./connection.js";

const SCHEMA_NAME = /^[a-z][a-z0-9_]{0,40}$/;
/** Any name PostgreSQL keeps whole (63 bytes): the aside name is longer than a name the storage accepts, and is only ever renamed. */
const ANY_NAME = /^[a-z][a-z0-9_]{0,62}$/;
const STAMP = /^[0-9]{8}T[0-9]{6}Z$/;
/** The application name every controller pool uses (`PostgresStorage.open`): a session with it on the same database is a controller that may be using the schema. */
export const CONTROLLER_APPLICATION = "nimblenewt-controller";
/** The key of the storage's migration lock (`PostgresStorage.#migrate`): the swap holds it, so a controller opening at that moment waits for the swap instead of migrating a schema that is being renamed. */
const LOCK_CLASS = 7306457;
/**
 * The key class of the lock every open storage holds SHARED on its schema's name for its whole life, on a connection of its own (`PostgresStorage.open`; second review of card K01i). The swap takes it EXCLUSIVELY
 * in its transaction for every name it renames, so a schema is never renamed while a controller has it open, whatever role it connects as, whatever application name it carries and even when its pool is idle
 * (pooled connections are closed after a while, so a running controller may have none in `pg_stat_activity`). The application-name count is kept as a second check (a controller of an older version holds no lock).
 */
export const LIVE_LOCK_CLASS = 7306458;
/** The text whose `hashtext` is the second half of the live lock's key. */
export const liveLockKey = (schema: string): string => `nimblenewt-live:${schema}`;

/** The staged schema of a restore of `live` prepared at `stamp`: short enough to be a storage schema (it is opened as one to be filled), tied to the live name by a digest so two installations in one database never share it. */
export function stagedSchemaOf(live: string, stamp: string): string {
  if (!SCHEMA_NAME.test(live) || !STAMP.test(stamp)) throw new Error("invalid schema name or restore stamp");
  return `nnrs_${createHash("sha256").update(live).digest("hex").slice(0, 8)}_${stamp.toLowerCase()}`;
}

/** Where the live schema goes when the restore is swapped in ("br": before restore); kept, never dropped. */
export function asideSchemaOf(live: string, stamp: string): string {
  if (!SCHEMA_NAME.test(live) || !STAMP.test(stamp)) throw new Error("invalid schema name or restore stamp");
  return `${live}_br_${stamp.toLowerCase()}`;
}

export interface SchemaSwap { readonly live: string; readonly staged: string; readonly aside: string }

/** Why a swap was not made: another controller is connected, or the migration lock is held by an open in progress. Nothing was changed. */
export class PostgresSwapBusy extends Error {
  readonly code = "EBUSY";
  constructor(message: string) { super(message); this.name = "PostgresSwapBusy"; }
}

export interface PostgresRestorePort {
  /** Whether the schema exists. */
  exists(schema: string): Promise<boolean>;
  /** Other controller sessions: connected to this database by application name, or (with `live`) holding the live lock of that schema; this connection excluded. */
  controllersConnected(live?: string): Promise<number>;
  /** In one transaction: live -> aside, staged -> live. Refused (PostgresSwapBusy) while a controller is connected or the migration lock is held. */
  swap(s: SchemaSwap): Promise<void>;
  /** The swap undone, in one transaction: live -> staged, aside -> live. */
  unswap(s: SchemaSwap): Promise<void>;
  /** Drops a staged schema this restore made (the name must be a staged name of `live`). Gone already is a success. */
  dropStaged(live: string, staged: string): Promise<void>;
  /** Why the database role could not make the swap (it must own `live` and may create schemas in the database: PostgreSQL's rule for a schema rename), or undefined when it can. Asked before a restore is prepared. */
  swapRefusal?(live: string): Promise<string | undefined>;
  /** The schemas earlier restores kept aside for `live` (`<live>_br_<stamp>`), oldest first. Nothing drops them; the owner is shown them so they can be removed by hand. */
  keptSchemas?(live: string): Promise<string[]>;
}

function check(s: SchemaSwap): void {
  if (!SCHEMA_NAME.test(s.live) || !SCHEMA_NAME.test(s.staged) || !ANY_NAME.test(s.aside) || new Set([s.live, s.staged, s.aside]).size !== 3) throw new Error("invalid schema names for a restore swap");
  if (!/^nnrs_[0-9a-f]{8}_[0-9]{8}t[0-9]{6}z$/.test(s.staged)) throw new Error("the staged schema does not have a staged restore's name");
}

/**
 * A short connection with client-side limits (`withShortConnection`): a server that stops answering fails the step as `PostgresNoAnswer` (the swap is one
 * transaction, so an unanswered swap is made entirely or not at all, and the restore at start checks which before it undoes anything).
 * Not the controller's application name: this short connection must not count as a controller using the schema.
 */
const withClient = <T>(connectionString: string, step: { name: string; writes: boolean }, work: (client: import("pg").Client) => Promise<T>): Promise<T> =>
  withShortConnection(connectionString, { ...step, applicationName: "nimblenewt-restore" }, work);

const schemaExists = async (c: import("pg").Client, schema: string): Promise<boolean> => (await c.query("SELECT 1 AS x FROM pg_namespace WHERE nspname = $1", [schema])).rows.length > 0;
const othersConnected = async (c: import("pg").Client, live?: string): Promise<number> => Number((await c.query(
  `SELECT count(DISTINCT pid)::int AS n FROM (
     SELECT pid FROM pg_stat_activity WHERE datname = current_database() AND application_name = $1
     UNION ALL
     SELECT pid FROM pg_locks WHERE $3::text IS NOT NULL AND locktype = 'advisory' AND database = (SELECT oid FROM pg_database WHERE datname = current_database())
       AND classid = $2::int4::oid AND objid = hashtext($3)::oid AND objsubid = 2 AND granted) x
   WHERE pid <> pg_backend_pid()`, [CONTROLLER_APPLICATION, LIVE_LOCK_CLASS, live === undefined ? null : liveLockKey(live)])).rows[0]?.n ?? 0);

async function renameInOne(connectionString: string, s: SchemaSwap, step: string, steps: readonly (readonly [string, string])[], expect: { absent: string; present: readonly string[] }): Promise<void> {
  await withClient(connectionString, { name: step, writes: true }, async (c) => {
    await c.query("BEGIN");
    try {
      if (!(await c.query("SELECT pg_try_advisory_xact_lock($1, hashtext($2)) AS got", [LOCK_CLASS, `nimblenewt:${s.live}`])).rows[0]?.got) throw new PostgresSwapBusy("a controller is opening this schema right now (its migration lock is held)");
      // Every name renamed here, exclusively: a controller that has any of them open holds its live lock shared (released only when it closes or its connection ends).
      for (const name of [s.live, s.staged, s.aside]) {
        if (!(await c.query("SELECT pg_try_advisory_xact_lock($1, hashtext($2)) AS got", [LIVE_LOCK_CLASS, liveLockKey(name)])).rows[0]?.got) throw new PostgresSwapBusy(`a controller has the schema ${name} open`);
      }
      const n = await othersConnected(c);
      if (n > 0) throw new PostgresSwapBusy(`${n} connection(s) of a running controller are open on this database`);
      for (const name of expect.present) if (!(await schemaExists(c, name))) throw new Error(`the schema ${name} is not there`);
      if (await schemaExists(c, expect.absent)) throw new Error(`the schema ${expect.absent} is already there`);
      for (const [from, to] of steps) await c.query(`ALTER SCHEMA ${from} RENAME TO ${to}`);
      await c.query("COMMIT");
    } catch (error) { await c.query("ROLLBACK").catch(() => undefined); throw error; }
  });
}

/** The port the staged restore uses on the database the address names. */
export function postgresRestorePort(connectionString: string): PostgresRestorePort {
  return {
    exists: async (schema) => { if (!ANY_NAME.test(schema)) throw new Error("invalid schema name"); return withClient(connectionString, { name: `checking whether schema ${schema} exists`, writes: false }, (c) => schemaExists(c, schema)); },
    controllersConnected: (live) => { if (live !== undefined && !SCHEMA_NAME.test(live)) throw new Error("invalid schema name"); return withClient(connectionString, { name: "checking for other controllers connected to the database", writes: false }, (c) => othersConnected(c, live)); },
    swap: async (s) => { check(s); await renameInOne(connectionString, s, `swapping the restored schema ${s.staged} in as ${s.live}`, [[s.live, s.aside], [s.staged, s.live]], { absent: s.aside, present: [s.live, s.staged] }); },
    unswap: async (s) => { check(s); await renameInOne(connectionString, s, `undoing the swap of the restored schema ${s.staged}`, [[s.live, s.staged], [s.aside, s.live]], { absent: s.staged, present: [s.live, s.aside] }); },
    dropStaged: async (live, staged) => {
      if (!SCHEMA_NAME.test(live) || !SCHEMA_NAME.test(staged) || !/^nnrs_[0-9a-f]{8}_[0-9]{8}t[0-9]{6}z$/.test(staged) || !staged.startsWith(stagedSchemaOf(live, "20000101T000000Z").slice(0, 14))) throw new Error("only a staged restore schema of this installation may be dropped");
      await withClient(connectionString, { name: `dropping the staged restore schema ${staged}`, writes: true }, async (c) => { await c.query(`DROP SCHEMA IF EXISTS ${staged} CASCADE`); });
    },
    keptSchemas: async (live) => {
      if (!SCHEMA_NAME.test(live)) throw new Error("invalid schema name");
      const pattern = `^${live}_br_[0-9]{8}t[0-9]{6}z$`;
      return withClient(connectionString, { name: "listing the schemas earlier restores kept", writes: false }, async (c) => (await c.query("SELECT nspname FROM pg_namespace WHERE nspname ~ $1 ORDER BY nspname", [pattern])).rows.map((r: { nspname: string }) => r.nspname));
    },
    swapRefusal: async (live) => {
      if (!SCHEMA_NAME.test(live)) throw new Error("invalid schema name");
      const row = await withClient(connectionString, { name: "checking that this role may swap a restore in", writes: false }, async (c) => (await c.query("SELECT has_database_privilege(current_database(), 'CREATE') AS can_create, (SELECT pg_has_role(nspowner, 'USAGE') FROM pg_namespace WHERE nspname = $1) AS owns", [live])).rows[0] as { can_create: boolean; owns: boolean | null } | undefined);
      if (row?.owns === false) return `the PostgreSQL role this controller uses does not own the schema ${live}, so it cannot rename it to swap a restore in (PostgreSQL lets only the schema's owner rename it); have the database administrator make this role the schema's owner, or restore from the command line`;
      if (row?.can_create !== true) return `the PostgreSQL role this controller uses may not create schemas in this database, so a restore cannot be staged in a new schema or swapped in (a schema rename needs CREATE on the database); have the database administrator grant it, or restore from the command line`;
      return undefined;
    },
  };
}
