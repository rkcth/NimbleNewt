import pg from "pg";
import { SUPPORTED_ENVIRONMENT } from "../../environment/supported.js";
import { checkEnvironment, detectEnvironment, refusalMessage, type Problem } from "../../environment/check.js";
import { StorageError } from "../errors.js";
import { operationHash } from "../hash.js";
import { canonicalJson, compareCodePoints, parseJson } from "../json.js";
import { checkBody, checkCount, checkId, checkKind, checkLease, checkPage, checkRef, checkText, checkTimestamp, validateOperation } from "../validate.js";
import type {
  Aggregate, AggregateRef, AuditRecord, ControllerStorage, DeliveryClaim, DeliveryRecord, EffectRecord, EffectStatus, Id, JsonObject, OperationInput,
  OperationResult, Page, StoredOperation, TimerClaim, TimerRecord, Timestamp,
} from "../types.js";
import { classify, isConnectionLoss } from "./errors.js";
import { migrationChecksum, planMigrations, type JournalEntry, type Migration } from "../migrations.js";
import { JOURNAL_SQL, MIGRATIONS } from "./schema.js";

export interface PostgresOptions {
  /**
   * A `postgres://` connection string (it contains the password: take it from the secret store, never from configuration).
   * TLS is whatever the string asks for (`sslmode`); it is not tested here. Session settings are sent as startup options, so the
   * connection must be direct, or through a pooler that forwards startup options (PgBouncer in transaction mode does not).
   */
  readonly connectionString: string;
  /** Schema that holds the controller tables; created if absent. Lower-case letters, digits and underscores. Default `nimblenewt`. */
  readonly schema?: string;
  /** Upper bound on pooled connections: the bounded pool. Default 10, at most 200. */
  readonly maxConnections?: number;
  /** How long to wait for a free pooled connection (and for a new connection to open) before failing as `retryable`. Default 5000. */
  readonly connectTimeoutMs?: number;
  /** How long a statement may wait for a row lock before failing as `retryable`. Default 5000. */
  readonly lockTimeoutMs?: number;
  /** How long a single statement may run. Default 30000. */
  readonly statementTimeoutMs?: number;
  /** For the migration qualification only: the migrations to apply instead of this version's own. Production code never sets it. */
  readonly migrations?: readonly Migration[];
  /**
   * Start on a server older than the supported minimum instead of refusing (card F04h). The operator sets this with the same switch as the
   * rest of the environment check (`--allow-unsupported-environment`); nothing else about the adapter changes. The problem is available
   * from `unsupportedServer` so start-up can print and audit it.
   */
  readonly allowUnsupportedServer?: boolean;
  /** For the qualification of the version check only: a minimum server version number stricter than the supported one (a lower value is refused). Production code never sets it. */
  readonly minimumServerVersionNum?: number;
}

/** The server and session settings in force, read back after they were applied. */
export interface PostgresSettings {
  readonly serverVersion: string;
  readonly serverVersionNum: number;
  /** The encoding of the database the controller connected to. Must be `UTF8`: bodies are JSON text. */
  readonly encoding: string;
  readonly schema: string;
  readonly schemaVersion: number;
  /** `on`: the server flushes WAL to disk before each commit returns. */
  readonly synchronousCommit: string;
  readonly fsync: string;
  readonly fullPageWrites: string;
  readonly isolation: string;
  readonly maxConnections: number;
  readonly lockTimeoutMs: number;
  readonly statementTimeoutMs: number;
}

/**
 * Oldest server version this build accepts: PostgreSQL 17 and above, the owner's decision of 2026-10-20 (card F04g). Older majors are
 * refused at open. They are verified separately and reported, not supported (docs: f04g-postgres-versions.md).
 */
export const MINIMUM_SERVER_VERSION_NUM = SUPPORTED_ENVIRONMENT.postgres.minimumMajor * 10000;
let serverFloor = MINIMUM_SERVER_VERSION_NUM;

/**
 * For the version verification only (card F04g): accept servers down to `floor` (for example 140000) in this process, so the same suites
 * can be run against PostgreSQL 14 to 16 and their results reported. Production code never calls this; it is applied by
 * `postgres/testing/older-servers.ts`, which `scripts/postgres-versions.mjs` loads with `node --import`.
 */
export function lowerServerFloorForVerification(floor: number): void {
  if (!Number.isSafeInteger(floor) || floor < 140000 || floor > MINIMUM_SERVER_VERSION_NUM) throw new RangeError("the verification floor must be between PostgreSQL 14 and the supported minimum");
  serverFloor = floor;
}

/** Why a server of this version is refused, or undefined when it is acceptable. */
export function serverVersionProblem(versionNum: number, version: string, floor: number = serverFloor): string | undefined {
  return versionNum < floor ? `PostgreSQL ${version} is older than the minimum this version of NimbleNewt supports (${Math.floor(MINIMUM_SERVER_VERSION_NUM / 10000)})` : undefined;
}

type Row = Record<string, unknown>;
interface Tx { q(sql: string, params?: unknown[]): Promise<Row[]> }

const optional = <K extends string, V>(name: K, value: V | undefined | null): { [P in K]?: V } => (value === undefined || value === null ? {} : ({ [name]: value } as { [P in K]?: V }));
const plus = (at: Timestamp, ms: number): Timestamp => new Date(Date.parse(at) + ms).toISOString();
const text = (row: Row, key: string): string => row[key] as string;
const count = (row: Row, key: string): number => row[key] as number;
const maybe = (row: Row, key: string): string | undefined => (row[key] === null ? undefined : (row[key] as string));
const key = (ref: AggregateRef): string => `${ref.kind}/${ref.id}`;
const sortedBy = <T>(items: readonly T[], keyOf: (item: T) => string): T[] => [...items].sort((a, b) => compareCodePoints(keyOf(a), keyOf(b)));
const SCHEMA_NAME = /^[a-z][a-z0-9_]{0,40}$/;

// int8 (bigint) columns hold counters and revisions, which the contract bounds at 2^53 - 1; read them as numbers, not strings.
const types = { getTypeParser: (oid: number, format?: "text" | "binary") => (oid === 20 ? (value: string) => Number(value) : pg.types.getTypeParser(oid, format as "text")) };

/**
 * The PostgreSQL implementation of `ControllerStorage` (card F04c), for the supported server deployment.
 *
 * Concurrency model. Writers run in parallel under READ COMMITTED; correctness comes from row-level rules, not from one global
 * lock:
 * - the operation row is inserted first with `ON CONFLICT DO NOTHING`, so two submissions of one operation ID serialise on the
 *   key and the second one sees the first's committed result (replay) or conflict;
 * - revisions are checked by conditional `UPDATE ... WHERE revision = expected`, creates by `INSERT ... ON CONFLICT DO NOTHING`,
 *   guards by `SELECT ... FOR SHARE`; delivery, effect and timer IDs by `ON CONFLICT DO NOTHING`;
 * - the primary epoch row is read `FOR SHARE` by every writer, so a takeover (an `UPDATE`) waits for in-flight writers and every
 *   later writer sees the new epoch;
 * - audit and delivery sequence numbers are taken from one counter row updated inside the transaction, after all other locks, so
 *   they follow commit order and never leave gaps;
 * - locks are taken in one fixed order (operation, epoch, aggregates by key, then delivery rows, timer rows (completed and
 *   cancelled together) and effect rows by ID, then new effects and timers by ID, then the counter row, then audit and new
 *   deliveries by ID), so this adapter's own transactions do not deadlock one another; PostgreSQL still detects any deadlock that
 *   does arise (for example from an outside session), and it is classified `retryable`;
 * - delivery and timer claims use `FOR UPDATE SKIP LOCKED` only to skip rows another claimant holds; the per-ordering-key rule is a
 *   `NOT EXISTS` over earlier undelivered messages, evaluated on the claimant's snapshot, which can only err on the side of
 *   holding a later message back.
 * Connections come from a bounded pool; waiting for one longer than the connect timeout is `retryable`. Transactions contain only
 * database work. Serialization failures cannot occur at this isolation level but are classified `retryable` if a server is
 * configured otherwise.
 */
export class PostgresStorage implements ControllerStorage {
  readonly #pool: pg.Pool;
  readonly #options: Required<Omit<PostgresOptions, "connectionString" | "migrations" | "allowUnsupportedServer" | "minimumServerVersionNum">>;
  readonly #version: { readonly allowUnsupported: boolean; readonly minimum: number | undefined };
  #unsupportedServer: Problem | undefined;
  #closed = false;
  #poolError: Error | undefined;

  private constructor(pool: pg.Pool, options: Required<Omit<PostgresOptions, "connectionString" | "migrations" | "allowUnsupportedServer" | "minimumServerVersionNum">>, version: { allowUnsupported: boolean; minimum: number | undefined }) {
    this.#pool = pool;
    this.#options = options;
    this.#version = version;
    pool.on("error", (error) => { this.#poolError = error; }); // an idle connection dropped; the pool discards it and the next use reconnects
  }

  /** The reason the server is older than the supported minimum, when it was accepted anyway because `allowUnsupportedServer` was set; undefined otherwise. Start-up prints and audits it. */
  get unsupportedServer(): Problem | undefined { return this.#unsupportedServer; }

  /** Connects, verifies the server settings, and creates or checks the schema. */
  static async open(options: PostgresOptions): Promise<PostgresStorage> {
    if (typeof options.connectionString !== "string" || !/^postgres(?:ql)?:\/\//.test(options.connectionString)) {
      throw new StorageError("invalid_input", "connectionString: must be a postgres:// URL", { path: "connectionString" });
    }
    // The enforced minimum can only be made stricter: a lower value would be a way to skip the refusal without any override being recorded.
    if (options.minimumServerVersionNum !== undefined && (!Number.isSafeInteger(options.minimumServerVersionNum) || options.minimumServerVersionNum < MINIMUM_SERVER_VERSION_NUM)) {
      throw new StorageError("invalid_input", `minimumServerVersionNum: must be a whole number of at least ${MINIMUM_SERVER_VERSION_NUM}; the supported minimum cannot be lowered here (use allowUnsupportedServer, which is recorded)`, { path: "minimumServerVersionNum" });
    }
    const schema = options.schema ?? "nimblenewt";
    if (!SCHEMA_NAME.test(schema)) throw new StorageError("invalid_input", "schema: must be lower-case letters, digits and underscores, starting with a letter (at most 41 characters)", { path: "schema" });
    const number = (name: string, value: number | undefined, fallback: number, min: number, max: number): number => {
      const v = value ?? fallback;
      if (!Number.isSafeInteger(v) || v < min || v > max) throw new StorageError("invalid_input", `${name}: must be a whole number from ${min} to ${max}`, { path: name });
      return v;
    };
    const resolved = {
      schema,
      maxConnections: number("maxConnections", options.maxConnections, 10, 1, 200),
      connectTimeoutMs: number("connectTimeoutMs", options.connectTimeoutMs, 5000, 1, 120_000),
      lockTimeoutMs: number("lockTimeoutMs", options.lockTimeoutMs, 5000, 1, 120_000),
      statementTimeoutMs: number("statementTimeoutMs", options.statementTimeoutMs, 30_000, 1, 3_600_000),
    };
    const pool = new pg.Pool({
      connectionString: options.connectionString,
      max: resolved.maxConnections,
      connectionTimeoutMillis: resolved.connectTimeoutMs,
      idleTimeoutMillis: 30_000,
      application_name: "nimblenewt-controller",
      types,
      // Session settings applied to every connection by the server at startup: our schema, durable commits, bounded waits.
      options: `-c search_path=${schema} -c synchronous_commit=on -c default_transaction_isolation=read\\ committed -c lock_timeout=${resolved.lockTimeoutMs} -c statement_timeout=${resolved.statementTimeoutMs} -c idle_in_transaction_session_timeout=${resolved.statementTimeoutMs}`,
    });
    const store = new PostgresStorage(pool, resolved, { allowUnsupported: options.allowUnsupportedServer === true, minimum: options.minimumServerVersionNum });
    try {
      await store.#verifyServer();
      await store.#migrate(options.migrations ?? MIGRATIONS);
      return store;
    } catch (error) {
      await pool.end().catch(() => undefined);
      throw classify(error);
    }
  }

  async #verifyServer(): Promise<void> {
    const s = await this.settings({ skipSchema: true });
    const floor = this.#version.minimum ?? serverFloor;
    if (s.serverVersionNum < floor) {
      const problems = checkEnvironment({ ...detectEnvironment(), postgresVersion: s.serverVersion }).filter((p) => p.item === "PostgreSQL");
      const problem = problems[0] ?? { item: "PostgreSQL" as const, found: s.serverVersion, supported: `${Math.floor(floor / 10000)} or newer`, howToTest: `run \`node scripts/postgres-versions.mjs ${Math.floor(s.serverVersionNum / 10000)}\` from a checkout of this version` };
      if (!this.#version.allowUnsupported) throw new StorageError("unavailable", refusalMessage([problem]));
      this.#unsupportedServer = problem;
    }
    if (s.encoding !== "UTF8") throw new StorageError("unavailable", `the database encoding is ${s.encoding}, not UTF8; the controller stores JSON text and needs a UTF8 database (create it with ENCODING 'UTF8'; on Windows the default is a legacy code page)`);
    if (s.fsync !== "on" || s.fullPageWrites !== "on") throw new StorageError("unavailable", `the PostgreSQL server is configured without durable writes (fsync=${s.fsync}, full_page_writes=${s.fullPageWrites}); refusing to store controller state on it`);
    if (s.synchronousCommit !== "on") throw new StorageError("unavailable", `synchronous_commit is "${s.synchronousCommit}", not "on", so commits would be acknowledged before they are flushed`);
    if (s.isolation !== "read committed") throw new StorageError("unavailable", `the session isolation level is "${s.isolation}", not "read committed"`);
  }

  /**
   * Brings the schema up to date, one journaled migration at a time (rules in `../migrations.ts`). One connection holds a
   * session-level advisory lock for the whole phase, so two processes opening at once migrate one after the other (the second finds
   * nothing left to do), and the lock disappears with the connection if the process dies. A schema that has tables but no journal was
   * not created by NimbleNewt and is refused untouched, as is a database from a newer version or with an edited migration.
   */
  async #migrate(migrations: readonly Migration[]): Promise<void> {
    const name = this.#options.schema;
    this.#usable();
    let client: pg.PoolClient;
    try { client = await this.#pool.connect(); } catch (error) { throw classify(error); }
    const ignore = () => undefined;
    client.on("error", ignore);
    let broken = false;
    const q = async (sql: string, params?: unknown[]): Promise<Row[]> => (await client.query(sql, params)).rows as Row[];
    // Waiting for another process's migration is not an error and a migration may legitimately run long, so the wait is a poll of
    // pg_try_advisory_lock, never a blocking lock call: a session blocked in a statement holds a snapshot, and CREATE INDEX
    // CONCURRENTLY in the running migration waits for every such snapshot, which would be a deadlock. The statements of this phase
    // are exempt from the session's statement timeout (restored afterwards).
    const lock = async (): Promise<void> => {
      const patience = Date.now() + 15 * 60_000;
      while (!(await q("SELECT pg_try_advisory_lock(7306457, hashtext($1)) AS got", [`nimblenewt:${name}`]))[0]!.got) {
        if (Date.now() > patience) throw new StorageError("retryable", "another process has been migrating this database for over 15 minutes; try again later");
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
      try {
        await q("SET statement_timeout = 0");
      } catch (error) {
        // The lock is held by this connection; do not hand the connection back to the pool still holding it.
        await q("SELECT pg_advisory_unlock(7306457, hashtext($1))", [`nimblenewt:${name}`]).catch(() => { broken = true; });
        throw error;
      }
    };
    try {
      await lock();
      try {
        // 1. The schema and its journal. A schema with tables but no journal is somebody else's.
        await q("BEGIN");
        try {
          if ((await q("SELECT 1 AS x FROM pg_namespace WHERE nspname = $1", [name])).length === 0) await q(`CREATE SCHEMA ${name}`);
          const journalExists = (await q("SELECT to_regclass($1) AS t", [`${name}.schema_migrations`]))[0]!.t !== null;
          if (!journalExists) {
            if (count((await q("SELECT count(*)::int AS n FROM information_schema.tables WHERE table_schema = $1", [name]))[0]!, "n") > 0) {
              throw new StorageError("unavailable", `schema "${name}" already has tables but no schema journal: either NimbleNewt did not create them, or they were created by a development build from before schema journals (card F04); recreate the schema. Nothing was changed.`);
            }
            await q(JOURNAL_SQL);
          }
          await q("COMMIT");
        } catch (error) {
          await q("ROLLBACK").catch(() => undefined);
          throw error;
        }
        // 2. One migration per round, until none is left. Every round must make progress, so the loop is bounded: a migration whose journal
        // entry does not stick (for example, statements that delete it) would otherwise be planned again forever.
        for (let rounds = 1; ; rounds++) {
          if (rounds > migrations.length + 2) throw new StorageError("unavailable", "the schema migrations are not making progress: a migration was applied but the journal does not show it; stopping instead of repeating it forever");
          await q("BEGIN");
          let committed = false;
          try {
            const journal = (await q("SELECT version, name, checksum, state FROM schema_migrations ORDER BY version")).map((r): JournalEntry => ({ version: count(r, "version"), name: text(r, "name"), checksum: text(r, "checksum"), state: text(r, "state") as JournalEntry["state"] }));
            const plan = planMigrations(migrations, journal);
            const next = plan.resume ?? plan.pending[0];
            if (next === undefined) { await q("COMMIT"); committed = true; return; }
            const record = (state: "running" | "done"): Promise<Row[]> => q("INSERT INTO schema_migrations (version, name, checksum, state, started_at, finished_at) VALUES ($1, $2, $3, $4, $5, $6) ON CONFLICT (version) DO UPDATE SET state = excluded.state, finished_at = excluded.finished_at",
              [next.version, next.name, migrationChecksum(next), state, new Date().toISOString(), state === "done" ? new Date().toISOString() : null]);
            if (next.transactional !== false) {
              // Statements and journal entry commit together: an interruption leaves the database exactly as it was.
              for (const statement of next.statements) await q(statement);
              await record("done");
              await q("COMMIT"); committed = true;
              continue;
            }
            // Not transactional: journal it as running (committed), run its idempotent statements on their own, then mark it done.
            if (plan.resume === undefined) await record("running");
            await q("COMMIT"); committed = true;
            for (const statement of next.statements) await q(statement);
            await q("UPDATE schema_migrations SET state = 'done', finished_at = $1 WHERE version = $2", [new Date().toISOString(), next.version]);
          } catch (error) {
            if (!committed) await q("ROLLBACK").catch(() => undefined);
            throw error;
          }
        }
      } finally {
        await q("RESET statement_timeout").catch(() => { broken = true; });
        await q("SELECT pg_advisory_unlock(7306457, hashtext($1))", [`nimblenewt:${name}`]).catch(() => { broken = true; });
      }
    } catch (error) {
      broken = broken || isConnectionLoss(error);
      throw error;
    } finally {
      client.off("error", ignore);
      client.release(broken);
    }
  }

  /** The server and session settings in force, read back from the database. */
  async settings(options: { skipSchema?: boolean } = {}): Promise<PostgresSettings> {
    const show = async (client: pg.PoolClient, name: string): Promise<string> => String((await client.query(`SHOW ${name}`)).rows[0]![name]);
    let client: pg.PoolClient;
    try { client = await this.#pool.connect(); } catch (error) { throw classify(error); }
    const ignore = () => undefined; // a dropped connection also emits an error event; the failing query reports it
    client.on("error", ignore);
    let broken = false;
    try {
      const version = options.skipSchema === true ? 0 : count((await client.query("SELECT COALESCE(MAX(version), 0)::int AS v FROM schema_migrations WHERE state = 'done'", [])).rows[0] as Row, "v");
      return {
        serverVersion: await show(client, "server_version"), serverVersionNum: Number(await show(client, "server_version_num")), encoding: String((await client.query("SELECT pg_encoding_to_char(encoding) AS e FROM pg_database WHERE datname = current_database()")).rows[0]!.e), schema: this.#options.schema, schemaVersion: version,
        synchronousCommit: await show(client, "synchronous_commit"), fsync: await show(client, "fsync"), fullPageWrites: await show(client, "full_page_writes"),
        isolation: await show(client, "default_transaction_isolation"), maxConnections: this.#options.maxConnections, lockTimeoutMs: this.#options.lockTimeoutMs, statementTimeoutMs: this.#options.statementTimeoutMs,
      };
    } catch (error) {
      broken = isConnectionLoss(error);
      throw classify(error);
    } finally {
      client.off("error", ignore);
      client.release(broken);
    }
  }

  // ------------------------------------------------------------------------------------------ plumbing

  #usable(): void {
    if (this.#closed) throw new StorageError("unavailable", "the storage is closed");
  }

  async #read<T>(fn: (tx: Tx) => Promise<T>): Promise<T> {
    this.#usable();
    let client: pg.PoolClient;
    try { client = await this.#pool.connect(); } catch (error) { throw classify(error); }
    const ignore = () => undefined; // a dropped connection also emits an error event; the failing query reports it
    client.on("error", ignore);
    let broken = false;
    try {
      return await fn({ q: async (sql, params) => (await client.query(sql, params as unknown[] | undefined)).rows as Row[] });
    } catch (error) {
      broken = isConnectionLoss(error);
      throw classify(error);
    } finally {
      client.off("error", ignore);
      client.release(broken);
    }
  }

  /**
   * Runs `fn` in one READ COMMITTED transaction on one pooled connection. Any failure rolls everything back. A lost connection
   * during the final COMMIT leaves the outcome unknown: `uncertain_commit` for the operation primitive (resolve by operation ID),
   * `retryable` for claims (safe to repeat because leases expire).
   */
  async #writeTransaction<T>(fn: (tx: Tx) => Promise<T>, onUnknownCommit: "uncertain_commit" | "retryable"): Promise<T> {
    this.#usable();
    let client: pg.PoolClient;
    try { client = await this.#pool.connect(); } catch (error) { throw classify(error); }
    const ignore = () => undefined;
    client.on("error", ignore);
    let broken = false;
    try {
      try {
        await client.query("BEGIN ISOLATION LEVEL READ COMMITTED READ WRITE");
      } catch (error) {
        broken = isConnectionLoss(error);
        throw classify(error);
      }
      let result: T;
      try {
        result = await fn({ q: async (sql, params) => (await client.query(sql, params as unknown[] | undefined)).rows as Row[] });
      } catch (error) {
        broken = isConnectionLoss(error);
        if (!broken) await client.query("ROLLBACK").catch(() => { broken = true; });
        throw classify(error);
      }
      try {
        await client.query("COMMIT");
      } catch (error) {
        broken = isConnectionLoss(error);
        if (!broken) await client.query("ROLLBACK").catch(() => { broken = true; });
        throw classify(error, "commit", onUnknownCommit);
      }
      return result;
    } finally {
      client.off("error", ignore);
      client.release(broken);
    }
  }

  async #fence(tx: Tx, epoch: unknown): Promise<void> {
    checkCount(epoch, "epoch", Number.MAX_SAFE_INTEGER, 1);
    // FOR SHARE: a takeover (an UPDATE of this row) waits for every writer that passed the fence, and later writers see the new epoch.
    const current = count((await tx.q("SELECT epoch FROM state WHERE singleton = 1 FOR SHARE"))[0]!, "epoch");
    if (epoch !== current) throw new StorageError("stale_epoch", `call is for epoch ${epoch} but the current epoch is ${current}`);
  }

  // ------------------------------------------------------------------------------------------- epochs

  async currentEpoch(): Promise<number> {
    return this.#read(async (tx) => count((await tx.q("SELECT epoch FROM state WHERE singleton = 1"))[0]!, "epoch"));
  }

  async acquireEpoch(input: { holder: string; at: Timestamp; expectedEpoch?: number }): Promise<{ epoch: number }> {
    this.#usable();
    checkText(input.holder, "holder");
    checkTimestamp(input.at, "at");
    if (input.expectedEpoch !== undefined) checkCount(input.expectedEpoch, "expectedEpoch");
    return this.#writeTransaction(async (tx) => {
      const rows = await tx.q("UPDATE state SET epoch = epoch + 1, holder = $1 WHERE singleton = 1 AND ($2::bigint IS NULL OR epoch = $2::bigint) RETURNING epoch", [input.holder, input.expectedEpoch ?? null]);
      if (rows.length === 0) {
        const current = count((await tx.q("SELECT epoch FROM state WHERE singleton = 1"))[0]!, "epoch");
        throw new StorageError("stale_epoch", `expected epoch ${input.expectedEpoch} but the current epoch is ${current}`);
      }
      return { epoch: count(rows[0]!, "epoch") };
    }, "retryable");
  }

  // --------------------------------------------------------------------------------- the write primitive

  async applyOperation(input: OperationInput): Promise<OperationResult> {
    this.#usable();
    validateOperation(input);
    const hash = operationHash(input);
    return this.#writeTransaction((tx) => this.#apply(tx, input, hash), "uncertain_commit");
  }

  async #apply(tx: Tx, input: OperationInput, hash: string): Promise<OperationResult> {
    // 1. Claim the operation ID. A concurrent submission of the same ID waits here, then sees this one's outcome.
    const claimed = await tx.q(
      "INSERT INTO operations (operation_id, request_hash, actor, correlation_id, at, result) VALUES ($1, $2, $3, $4, $5, '{}') ON CONFLICT (operation_id) DO NOTHING RETURNING operation_id",
      [input.operationId, hash, input.actor, input.correlationId, input.at]);
    if (claimed.length === 0) {
      const existing = (await tx.q("SELECT request_hash, result FROM operations WHERE operation_id = $1", [input.operationId]))[0];
      if (existing === undefined) throw new StorageError("retryable", `operation ${input.operationId} was being admitted by a transaction that rolled back; try again`);
      if (text(existing, "request_hash") !== hash) throw new StorageError("idempotency_conflict", `operation ${input.operationId} was already used with different content`);
      return { ...(parseJson(text(existing, "result")) as unknown as OperationResult), replayed: true };
    }
    // 2. Fence.
    await this.#fence(tx, input.epoch);

    // Refusals are collected, not thrown on the spot: locks must be taken in a fixed order (below), but the contract promises that
    // when several things are wrong the error reported is the first in this order: changes, receipts, timer completions, effect
    // settlements, duplicate deliveries, duplicate effects, duplicate timers, each in argument order. Every backend must agree.
    const failures: { rank: number; index: number; error: StorageError }[] = [];
    const refuse = (rank: number, index: number, kind: ConstructorParameters<typeof StorageError>[0], message: string): void => { failures.push({ rank, index, error: new StorageError(kind, message) }); };

    // 3. Aggregates, in key order so concurrent operations cannot deadlock one another.
    const revisions: { ref: AggregateRef; revision: number }[] = input.changes.map((c) => ({ ref: c.ref, revision: 0 }));
    const order = input.changes.map((change, i) => ({ change, i })).sort((a, b) => compareCodePoints(key(a.change.ref), key(b.change.ref)));
    for (const { change, i } of order) {
      const label = `${key(change.ref)} (changes[${i}])`;
      if (change.type === "create") {
        const created = await tx.q("INSERT INTO aggregates (kind, id, revision, body, created_at, updated_at) VALUES ($1, $2, 1, $3, $4, $4) ON CONFLICT (kind, id) DO NOTHING RETURNING revision", [change.ref.kind, change.ref.id, canonicalJson(change.body), input.at]);
        if (created.length === 0) refuse(0, i, "revision_conflict", `${label} already exists`);
        else revisions[i]!.revision = 1;
      } else if (change.type === "update") {
        const updated = await tx.q("UPDATE aggregates SET revision = revision + 1, body = $3, updated_at = $4 WHERE kind = $1 AND id = $2 AND revision = $5 RETURNING revision", [change.ref.kind, change.ref.id, canonicalJson(change.body), input.at, change.expectedRevision]);
        if (updated.length === 0) {
          const now = (await tx.q("SELECT revision FROM aggregates WHERE kind = $1 AND id = $2", [change.ref.kind, change.ref.id]))[0];
          if (now === undefined) refuse(0, i, "not_found", `${label} does not exist`);
          else refuse(0, i, "revision_conflict", `${label} is at revision ${count(now, "revision")}, expected ${change.expectedRevision}`);
        } else revisions[i]!.revision = count(updated[0]!, "revision");
      } else {
        const row = (await tx.q("SELECT revision FROM aggregates WHERE kind = $1 AND id = $2 FOR SHARE", [change.ref.kind, change.ref.id]))[0];
        if (row === undefined) refuse(0, i, "not_found", `${label} does not exist`);
        else if (count(row, "revision") !== change.expectedRevision) refuse(0, i, "revision_conflict", `${label} is at revision ${count(row, "revision")}, expected ${change.expectedRevision}`);
        else revisions[i]!.revision = change.expectedRevision;
      }
    }

    // 4. Reconciliation: lock the rows in ID order (deliveries, then timers, then effects), then judge them in argument order.
    const deliveries = new Map<string, Row | undefined>();
    for (const id of [...new Set(input.completeDeliveries.map((c) => c.deliveryId))].sort(compareCodePoints)) {
      deliveries.set(id, (await tx.q("SELECT state, token, receipt FROM deliveries WHERE delivery_id = $1 FOR UPDATE", [id]))[0]);
    }
    // Timers that are completed and timers that are cancelled are locked in ONE pass in ID order: two operations that complete
    // and cancel each other's timers would otherwise take the same locks in opposite orders.
    const timerRows = new Map<string, Row | undefined>();
    for (const id of [...new Set([...input.completeTimers.map((c) => c.timerId), ...input.cancelTimers])].sort(compareCodePoints)) {
      timerRows.set(id, (await tx.q("SELECT state, token FROM timers WHERE timer_id = $1 FOR UPDATE", [id]))[0]);
    }
    const effectRows = new Map<string, Row | undefined>();
    for (const id of [...new Set(input.settleEffects.map((c) => c.effectId))].sort(compareCodePoints)) {
      effectRows.set(id, (await tx.q("SELECT status FROM effects WHERE effect_id = $1 FOR UPDATE", [id]))[0]);
    }
    for (const [j, c] of input.completeDeliveries.entries()) {
      const d = deliveries.get(c.deliveryId);
      if (d === undefined) refuse(1, j, "not_found", `delivery ${c.deliveryId} does not exist`);
      else if (text(d, "state") === "delivered") {
        if (maybe(d, "receipt") !== canonicalJson(c.receipt)) refuse(1, j, "state_conflict", `delivery ${c.deliveryId} was already delivered with a different receipt`);
      } else if (text(d, "state") !== "claimed" || maybe(d, "token") !== c.claimToken) refuse(1, j, "state_conflict", `delivery ${c.deliveryId} is not held by this claim`);
    }
    for (const [j, c] of input.completeTimers.entries()) {
      const t = timerRows.get(c.timerId);
      if (t === undefined) { refuse(2, j, "not_found", `timer ${c.timerId} does not exist`); continue; }
      const repeat = text(t, "state") === "completed" && maybe(t, "token") === c.claimToken;
      if (!repeat && (text(t, "state") !== "claimed" || maybe(t, "token") !== c.claimToken)) refuse(2, j, "state_conflict", `timer ${c.timerId} is not held by this claim`);
    }
    const previous = new Map<string, string>();
    for (const [j, c] of input.settleEffects.entries()) {
      const e = effectRows.get(c.effectId);
      if (e === undefined) { refuse(3, j, "not_found", `effect ${c.effectId} does not exist`); continue; }
      const status = text(e, "status");
      if (status !== c.outcome && (status === "confirmed" || status === "failed")) refuse(3, j, "state_conflict", `effect ${c.effectId} is already ${status}`);
      previous.set(c.effectId, status);
    }

    // 5. Identity of new things. Deliveries are looked at here only so a refusal can be ranked; the insert below is what is race-safe.
    for (const [j, o] of input.outbox.entries()) {
      if ((await tx.q("SELECT 1 AS x FROM deliveries WHERE delivery_id = $1", [o.deliveryId])).length > 0) refuse(4, j, "duplicate_id", `delivery ${o.deliveryId} already exists`);
    }
    for (const { e, j } of input.effects.map((e, j) => ({ e, j })).sort((a, b) => compareCodePoints(a.e.effectId, b.e.effectId))) {
      const made = await tx.q("INSERT INTO effects (effect_id, operation_id, attempt_id, target, input_digest, reconciliation_handle, status, created_at, updated_at) VALUES ($1, $2, $3, $4, $5, $6, 'intended', $7, $7) ON CONFLICT (effect_id) DO NOTHING RETURNING effect_id",
        [e.effectId, input.operationId, e.attemptId ?? null, e.target, e.inputDigest, e.reconciliationHandle ?? null, input.at]);
      if (made.length === 0) refuse(5, j, "duplicate_id", `effect ${e.effectId} already exists`);
    }
    for (const { t, j } of input.timers.map((t, j) => ({ t, j })).sort((a, b) => compareCodePoints(a.t.timerId, b.t.timerId))) {
      const made = await tx.q("INSERT INTO timers (timer_id, due_at, aggregate_kind, aggregate_id, payload, state, attempts) VALUES ($1, $2, $3, $4, $5, 'pending', 0) ON CONFLICT (timer_id) DO NOTHING RETURNING timer_id",
        [t.timerId, t.dueAt, t.aggregate?.kind ?? null, t.aggregate?.id ?? null, canonicalJson(t.payload)]);
      if (made.length === 0) refuse(6, j, "duplicate_id", `timer ${t.timerId} already exists`);
    }
    if (failures.length > 0) throw failures.sort((a, b) => a.rank - b.rank || a.index - b.index)[0]!.error; // everything is rolled back with the transaction
    for (const id of sortedBy(input.cancelTimers, (x) => x)) {
      const row = timerRows.get(id);
      if (row !== undefined && (text(row, "state") === "pending" || text(row, "state") === "claimed")) await tx.q("UPDATE timers SET state = 'cancelled' WHERE timer_id = $1", [id]);
    }

    // 6. Sequence numbers from the counter row. Taking it last and holding it to commit makes numbers follow commit order.
    const settlements = sortedBy(input.settleEffects, (x) => x.effectId);
    const auditCount = input.audit.length + settlements.length;
    const deliveryCount = input.outbox.length;
    let auditBase = 0;
    let deliveryBase = 0;
    if (auditCount > 0 || deliveryCount > 0) {
      const counters = (await tx.q("UPDATE counters SET audit_seq = audit_seq + $1, delivery_seq = delivery_seq + $2 WHERE singleton = 1 RETURNING audit_seq, delivery_seq", [auditCount, deliveryCount]))[0]!;
      auditBase = count(counters, "audit_seq") - auditCount;
      deliveryBase = count(counters, "delivery_seq") - deliveryCount;
    }

    // 7. Audit in the operation's order (explicit entries, then automatic effect settlements in the order given), then state changes.
    const auditSeqs: number[] = [];
    const insertAudit = async (type: string, subject: AggregateRef | undefined, detail: string): Promise<void> => {
      const seq = auditBase + auditSeqs.length + 1;
      auditSeqs.push(seq);
      await tx.q("INSERT INTO audit (seq, operation_id, correlation_id, actor, at, type, subject_kind, subject_id, detail) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)",
        [seq, input.operationId, input.correlationId, input.actor, input.at, type, subject?.kind ?? null, subject?.id ?? null, detail]);
    };
    for (const a of input.audit) await insertAudit(a.type, a.subject, canonicalJson(a.detail));
    for (const c of input.settleEffects) {
      await insertAudit("effect.settled", { kind: "effect", id: c.effectId }, canonicalJson({ outcome: c.outcome, previous: previous.get(c.effectId)! }));
      if (previous.get(c.effectId) !== c.outcome) {
        await tx.q("UPDATE effects SET status = $1, updated_at = $2, evidence = COALESCE($3, evidence) WHERE effect_id = $4", [c.outcome, input.at, c.evidence === undefined ? null : canonicalJson(c.evidence), c.effectId]);
      }
    }
    for (const c of input.completeDeliveries) {
      if (text(deliveries.get(c.deliveryId)!, "state") !== "delivered") {
        await tx.q("UPDATE deliveries SET state = 'delivered', receipt = $1, delivered_at = $2, claimed_until = NULL WHERE delivery_id = $3", [canonicalJson(c.receipt), input.at, c.deliveryId]);
      }
    }
    for (const c of input.completeTimers) await tx.q("UPDATE timers SET state = 'completed', claimed_until = NULL WHERE timer_id = $1 AND state <> 'completed'", [c.timerId]);
    // Inserted in ID order and numbered in argument order. (Deliveries are inserted while this transaction holds the counter row, which already serialises operations that write them, so the order is belt and braces here, unlike for effects and timers.)
    for (const { o, i } of input.outbox.map((o, i) => ({ o, i })).sort((a, b) => compareCodePoints(a.o.deliveryId, b.o.deliveryId))) {
      const revision = revisions.find((r) => key(r.ref) === key(o.aggregate))!.revision;
      const made = await tx.q("INSERT INTO deliveries (delivery_id, seq, destination, ordering_key, priority, aggregate_kind, aggregate_id, aggregate_revision, payload, state, attempts, next_attempt_at) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, 'pending', 0, $10) ON CONFLICT (delivery_id) DO NOTHING RETURNING delivery_id",
        [o.deliveryId, deliveryBase + i + 1, o.destination, o.orderingKey ?? null, o.priority, o.aggregate.kind, o.aggregate.id, revision, canonicalJson(o.payload), o.notBefore ?? input.at]);
      if (made.length === 0) throw new StorageError("duplicate_id", `delivery ${o.deliveryId} already exists`);
    }

    const result: OperationResult = { operationId: input.operationId, replayed: false, revisions, auditSeqs, epoch: input.epoch };
    await tx.q("UPDATE operations SET result = $1 WHERE operation_id = $2", [canonicalJson(result), input.operationId]);
    return result;
  }

  async getOperation(operationId: Id): Promise<StoredOperation | undefined> {
    checkId(operationId, "operationId");
    return this.#read(async (tx) => {
      const row = (await tx.q("SELECT request_hash, actor, correlation_id, at, result FROM operations WHERE operation_id = $1", [operationId]))[0];
      if (row === undefined) return undefined;
      return { operationId, requestHash: text(row, "request_hash"), actor: text(row, "actor"), correlationId: text(row, "correlation_id"), at: text(row, "at"), result: parseJson(text(row, "result")) as unknown as OperationResult };
    });
  }

  // ---------------------------------------------------------------------------------------------- reads

  #aggregate(row: Row): Aggregate {
    return { kind: text(row, "kind"), id: text(row, "id"), revision: count(row, "revision"), body: parseJson(text(row, "body")) as JsonObject, createdAt: text(row, "created_at"), updatedAt: text(row, "updated_at") };
  }

  async getAggregate(ref: AggregateRef): Promise<Aggregate | undefined> {
    checkRef(ref, "ref");
    return this.#read(async (tx) => {
      const row = (await tx.q("SELECT kind, id, revision, body, created_at, updated_at FROM aggregates WHERE kind = $1 AND id = $2", [ref.kind, ref.id]))[0];
      return row === undefined ? undefined : this.#aggregate(row);
    });
  }

  async listAggregates(kind: string, page: Page): Promise<Aggregate[]> {
    checkKind(kind, "kind");
    checkPage(page);
    return this.#read(async (tx) => (await tx.q("SELECT kind, id, revision, body, created_at, updated_at FROM aggregates WHERE kind = $1 AND id > $2 ORDER BY id LIMIT $3", [kind, page.afterId ?? "", page.limit])).map((r) => this.#aggregate(r)));
  }

  async listAudit(input: { afterSeq: number; limit: number }): Promise<AuditRecord[]> {
    checkCount(input.afterSeq, "afterSeq");
    checkCount(input.limit, "limit", 1000, 1);
    return this.#read(async (tx) => (await tx.q("SELECT seq, operation_id, correlation_id, actor, at, type, subject_kind, subject_id, detail FROM audit WHERE seq > $1 ORDER BY seq LIMIT $2", [input.afterSeq, input.limit])).map((r) => ({
      seq: count(r, "seq"), operationId: text(r, "operation_id"), correlationId: text(r, "correlation_id"), actor: text(r, "actor"), at: text(r, "at"), type: text(r, "type"),
      ...(r.subject_kind === null ? {} : { subject: { kind: text(r, "subject_kind"), id: text(r, "subject_id") } }), detail: parseJson(text(r, "detail")) as JsonObject,
    })));
  }

  // ---------------------------------------------------------------------------------------- deliveries

  async claimDeliveries(input: { epoch: number; destination: string; claimant: string; now: Timestamp; leaseMs: number; limit: number }): Promise<DeliveryClaim[]> {
    this.#usable();
    checkCount(input.epoch, "epoch", Number.MAX_SAFE_INTEGER, 1);
    checkText(input.destination, "destination");
    checkText(input.claimant, "claimant");
    checkTimestamp(input.now, "now");
    checkLease(input.leaseMs, input.limit, "claim");
    return this.#writeTransaction(async (tx) => {
      await this.#fence(tx, input.epoch);
      const rows = await tx.q(
        `WITH picked AS (
           SELECT d.delivery_id FROM deliveries d
           WHERE d.destination = $1 AND d.state <> 'delivered' AND (d.state = 'pending' OR d.claimed_until <= $2) AND d.next_attempt_at <= $2
             AND (d.ordering_key IS NULL OR NOT EXISTS (
               SELECT 1 FROM deliveries e WHERE e.destination = d.destination AND e.ordering_key = d.ordering_key AND e.state <> 'delivered' AND e.seq < d.seq))
           ORDER BY d.priority DESC, d.seq ASC LIMIT $3
           FOR UPDATE OF d SKIP LOCKED)
         UPDATE deliveries x SET state = 'claimed', attempts = x.attempts + 1, claimed_until = $4, token = x.delivery_id || '#' || (x.attempts + 1)
         FROM picked WHERE x.delivery_id = picked.delivery_id
         RETURNING x.delivery_id, x.token, x.attempts, x.destination, x.ordering_key, x.priority, x.aggregate_kind, x.aggregate_id, x.aggregate_revision, x.payload, x.claimed_until, x.seq`,
        [input.destination, input.now, input.limit, plus(input.now, input.leaseMs)]);
      return rows.sort((a, b) => count(b, "priority") - count(a, "priority") || count(a, "seq") - count(b, "seq")).map((d) => ({
        deliveryId: text(d, "delivery_id"), claimToken: text(d, "token"), attempt: count(d, "attempts"), destination: text(d, "destination"), ...optional("orderingKey", maybe(d, "ordering_key")), priority: count(d, "priority"),
        aggregate: { kind: text(d, "aggregate_kind"), id: text(d, "aggregate_id") }, aggregateRevision: count(d, "aggregate_revision"), payload: parseJson(text(d, "payload")) as JsonObject, claimedUntil: text(d, "claimed_until"),
      }));
    }, "retryable");
  }

  async retryDelivery(input: { epoch: number; deliveryId: Id; claimToken: string; nextAttemptAt: Timestamp; reason: string; at: Timestamp }): Promise<void> {
    this.#usable();
    checkCount(input.epoch, "epoch", Number.MAX_SAFE_INTEGER, 1);
    checkId(input.deliveryId, "deliveryId");
    checkText(input.claimToken, "claimToken");
    checkTimestamp(input.nextAttemptAt, "nextAttemptAt");
    checkText(input.reason, "reason");
    checkTimestamp(input.at, "at");
    await this.#writeTransaction(async (tx) => {
      await this.#fence(tx, input.epoch);
      const updated = await tx.q("UPDATE deliveries SET state = 'pending', next_attempt_at = $1, last_error = $2, claimed_until = NULL WHERE delivery_id = $3 AND state = 'claimed' AND token = $4 RETURNING delivery_id",
        [input.nextAttemptAt, input.reason, input.deliveryId, input.claimToken]);
      if (updated.length === 0) {
        const exists = await tx.q("SELECT 1 AS x FROM deliveries WHERE delivery_id = $1", [input.deliveryId]);
        throw exists.length === 0 ? new StorageError("not_found", `delivery ${input.deliveryId} does not exist`) : new StorageError("state_conflict", `delivery ${input.deliveryId} is not held by this claim`);
      }
    }, "retryable");
  }

  async getDelivery(deliveryId: Id): Promise<DeliveryRecord | undefined> {
    checkId(deliveryId, "deliveryId");
    return this.#read(async (tx) => {
      const d = (await tx.q("SELECT * FROM deliveries WHERE delivery_id = $1", [deliveryId]))[0];
      if (d === undefined) return undefined;
      return {
        deliveryId, seq: count(d, "seq"), destination: text(d, "destination"), ...optional("orderingKey", maybe(d, "ordering_key")), priority: count(d, "priority"),
        aggregate: { kind: text(d, "aggregate_kind"), id: text(d, "aggregate_id") }, aggregateRevision: count(d, "aggregate_revision"), payload: parseJson(text(d, "payload")) as JsonObject,
        state: text(d, "state") as DeliveryRecord["state"], attempts: count(d, "attempts"), nextAttemptAt: text(d, "next_attempt_at"), ...optional("claimedUntil", maybe(d, "claimed_until")),
        ...optional("lastError", maybe(d, "last_error")), ...optional("receipt", maybe(d, "receipt") === undefined ? undefined : (parseJson(maybe(d, "receipt")!) as JsonObject)), ...optional("deliveredAt", maybe(d, "delivered_at")),
      };
    });
  }

  // ------------------------------------------------------------------------------------------- effects

  async getEffect(effectId: Id): Promise<EffectRecord | undefined> {
    checkId(effectId, "effectId");
    return this.#read(async (tx) => {
      const e = (await tx.q("SELECT * FROM effects WHERE effect_id = $1", [effectId]))[0];
      if (e === undefined) return undefined;
      return {
        effectId, operationId: text(e, "operation_id"), ...optional("attemptId", maybe(e, "attempt_id")), target: text(e, "target"), inputDigest: text(e, "input_digest"),
        ...optional("reconciliationHandle", maybe(e, "reconciliation_handle")), status: text(e, "status") as EffectStatus,
        ...optional("evidence", maybe(e, "evidence") === undefined ? undefined : (parseJson(maybe(e, "evidence")!) as JsonObject)), createdAt: text(e, "created_at"), updatedAt: text(e, "updated_at"),
      };
    });
  }

  // --------------------------------------------------------------------------------------------- timers

  async claimDueTimers(input: { epoch: number; claimant: string; now: Timestamp; leaseMs: number; limit: number }): Promise<TimerClaim[]> {
    this.#usable();
    checkCount(input.epoch, "epoch", Number.MAX_SAFE_INTEGER, 1);
    checkText(input.claimant, "claimant");
    checkTimestamp(input.now, "now");
    checkLease(input.leaseMs, input.limit, "claim");
    return this.#writeTransaction(async (tx) => {
      await this.#fence(tx, input.epoch);
      const rows = await tx.q(
        `WITH picked AS (
           SELECT timer_id FROM timers WHERE (state = 'pending' OR (state = 'claimed' AND claimed_until <= $1)) AND due_at <= $1
           ORDER BY due_at, timer_id LIMIT $2 FOR UPDATE SKIP LOCKED)
         UPDATE timers x SET state = 'claimed', attempts = x.attempts + 1, claimed_until = $3, token = x.timer_id || '#' || (x.attempts + 1)
         FROM picked WHERE x.timer_id = picked.timer_id
         RETURNING x.timer_id, x.token, x.attempts, x.due_at, x.aggregate_kind, x.aggregate_id, x.payload, x.claimed_until`,
        [input.now, input.limit, plus(input.now, input.leaseMs)]);
      return rows.sort((a, b) => compareCodePoints(text(a, "due_at"), text(b, "due_at")) || compareCodePoints(text(a, "timer_id"), text(b, "timer_id"))).map((t) => ({
        timerId: text(t, "timer_id"), claimToken: text(t, "token"), attempt: count(t, "attempts"), dueAt: text(t, "due_at"),
        ...(t.aggregate_kind === null ? {} : { aggregate: { kind: text(t, "aggregate_kind"), id: text(t, "aggregate_id") } }), payload: parseJson(text(t, "payload")) as JsonObject, claimedUntil: text(t, "claimed_until"),
      }));
    }, "retryable");
  }

  async getTimer(timerId: Id): Promise<TimerRecord | undefined> {
    checkId(timerId, "timerId");
    return this.#read(async (tx) => {
      const t = (await tx.q("SELECT * FROM timers WHERE timer_id = $1", [timerId]))[0];
      if (t === undefined) return undefined;
      return {
        timerId, dueAt: text(t, "due_at"), ...(t.aggregate_kind === null ? {} : { aggregate: { kind: text(t, "aggregate_kind"), id: text(t, "aggregate_id") } }), payload: parseJson(text(t, "payload")) as JsonObject,
        state: text(t, "state") as TimerRecord["state"], attempts: count(t, "attempts"), ...optional("claimedUntil", maybe(t, "claimed_until")),
      };
    });
  }

  async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    await this.#pool.end();
  }

  /** Connections now open, idle and waiting for a free one: the pool pressure, for workload reports. */
  poolStats(): { total: number; idle: number; waiting: number } {
    return { total: this.#pool.totalCount, idle: this.#pool.idleCount, waiting: this.#pool.waitingCount };
  }

  /** The last error reported by an idle pooled connection, if any (for diagnostics). */
  get lastPoolError(): Error | undefined { return this.#poolError; }
}
