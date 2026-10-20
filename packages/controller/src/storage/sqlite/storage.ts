import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { DatabaseSync, type SQLInputValue, type StatementSync } from "node:sqlite";
import { StorageError } from "../errors.js";
import { operationHash } from "../hash.js";
import { canonicalJson, parseJson } from "../json.js";
import { checkBody, checkCount, checkId, checkKind, checkLease, checkPage, checkRef, checkText, checkTimestamp, validateOperation } from "../validate.js";
import type {
  Aggregate, AggregateRef, AuditRecord, ControllerStorage, DeliveryClaim, DeliveryRecord, EffectRecord, EffectStatus, Id, JsonObject, OperationInput,
  OperationResult, Page, StoredOperation, TimerClaim, TimerRecord, Timestamp,
} from "../types.js";
import { classify, isBusy } from "./errors.js";
import { assertLocalFilesystem } from "./filesystem.js";
import { migrationChecksum, planMigrations, type JournalEntry, type Migration } from "../migrations.js";
import { JOURNAL_SQL, MIGRATIONS } from "./schema.js";

export interface SqliteOptions {
  /** Path of the database file on local storage. `:memory:` is refused: a controller database must be durable. */
  readonly path: string;
  /** How long a write waits for another connection's write lock before failing as `retryable`. Default 5000, at most 60000. */
  readonly busyTimeoutMs?: number;
  /**
   * For the crash qualification only: called immediately before and after every numbered statement of a write transaction
   * (`BEGIN IMMEDIATE` is statement 1, `COMMIT` the last), so a test can kill the process at an exact atomic boundary.
   * Never set in production.
   */
  readonly testHooks?: { readonly statement?: (phase: "before" | "after", sql: string, ordinal: number) => void };
  /**
   * For the migration qualification only: the migrations to apply instead of this version's own. Production code never sets it.
   */
  readonly migrations?: readonly Migration[];
}

/** The durability and safety settings in force, read back from the database after they were applied. */
export interface SqliteSettings {
  readonly sqliteVersion: string;
  readonly schemaVersion: number;
  readonly journalMode: string;
  /** `FULL`: the log is flushed to disk before each commit returns, so a committed operation survives power loss. */
  readonly synchronous: string;
  readonly foreignKeys: boolean;
  readonly busyTimeoutMs: number;
}

type Row = Record<string, unknown>;
const optional = <K extends string, V>(name: K, value: V | undefined | null): { [P in K]?: V } => (value === undefined || value === null ? {} : ({ [name]: value } as { [P in K]?: V }));
const plus = (at: Timestamp, ms: number): Timestamp => new Date(Date.parse(at) + ms).toISOString();
const text = (row: Row, key: string): string => row[key] as string;
const count = (row: Row, key: string): number => row[key] as number;
const maybe = (row: Row, key: string): string | undefined => (row[key] === null ? undefined : (row[key] as string));

/**
 * The SQLite implementation of `ControllerStorage` (card F04b), for the simple local installation.
 *
 * Every write is one `BEGIN IMMEDIATE ... COMMIT` transaction on one connection (explicit write admission: a second writer
 * waits at most `busyTimeoutMs`, then fails as `retryable`, rolled back). Writes touch only the rows they need and never
 * wait on anything but the database, so transactions are short. The database runs in WAL mode with `synchronous = FULL`,
 * foreign keys on, and a bounded busy timeout; the settings are read back and checked when the store is opened. All SQL
 * lives in this folder; domain code sees only the typed contract.
 *
 * A method runs to completion without yielding, so calls on one `SqliteStorage` never interleave; contention comes from
 * other connections and processes, which the file lock and `retryable` classification handle.
 */
export class SqliteStorage implements ControllerStorage {
  readonly #db: DatabaseSync;
  readonly #busyTimeoutMs: number;
  readonly #hook: SqliteOptions["testHooks"];
  #ordinal = 0;
  #inWrite = false;
  readonly #statements = new Map<string, StatementSync>();
  #closed = false;
  readonly path: string;

  private constructor(db: DatabaseSync, path: string, busyTimeoutMs: number, hook: SqliteOptions["testHooks"]) {
    this.#hook = hook;
    this.#db = db;
    this.path = path;
    this.#busyTimeoutMs = busyTimeoutMs;
  }

  /** Opens (creating if absent) the database, applies and verifies the durability settings, and creates or checks the schema. */
  static async open(options: SqliteOptions): Promise<SqliteStorage> {
    const path = options.path;
    if (typeof path !== "string" || path.length === 0 || path === ":memory:" || path.startsWith("file:")) {
      throw new StorageError("invalid_input", "path: must be a file path on local storage (':memory:' and URIs are not allowed)", { path: "path" });
    }
    const busyTimeoutMs = options.busyTimeoutMs ?? 5000;
    if (!Number.isSafeInteger(busyTimeoutMs) || busyTimeoutMs < 0 || busyTimeoutMs > 60_000) throw new StorageError("invalid_input", "busyTimeoutMs: must be a whole number from 0 to 60000", { path: "busyTimeoutMs" });
    assertLocalFilesystem(path); // as given: a UNC path must be recognised before it is resolved against this machine
    const absolute = resolve(path);
    assertLocalFilesystem(absolute);
    mkdirSync(dirname(absolute), { recursive: true });
    let db: DatabaseSync | undefined;
    try {
      db = new DatabaseSync(absolute, { timeout: busyTimeoutMs, enableForeignKeyConstraints: true });
      const store = new SqliteStorage(db, absolute, busyTimeoutMs, options.testHooks);
      store.#configure();
      store.#migrate(options.migrations ?? MIGRATIONS);
      return store;
    } catch (error) {
      try { db?.close(); } catch { /* already unusable */ }
      throw classify(error);
    }
  }

  #configure(): void {
    const mode = (this.#db.prepare("PRAGMA journal_mode = WAL").get() as Row | undefined)?.journal_mode;
    if (mode !== "wal") throw new StorageError("unavailable", `the database could not enter WAL mode (it answered "${String(mode)}"); this usually means a file system that cannot support it, such as a network share`);
    this.#db.exec("PRAGMA synchronous = FULL");
    this.#db.exec("PRAGMA foreign_keys = ON");
    this.#db.exec("PRAGMA trusted_schema = OFF");
    this.#db.exec("PRAGMA journal_size_limit = 67108864"); // the WAL file shrinks back to 64 MiB after a spike; auto-checkpoint stays at SQLite's default of 1000 pages
    const settings = this.settings();
    if (settings.synchronous !== "FULL" || !settings.foreignKeys) throw new StorageError("unavailable", `the durability settings did not take effect: ${JSON.stringify(settings)}`);
  }

  /**
   * Brings the schema up to date, one journaled migration at a time (rules in `../migrations.ts`). The whole phase is numbered for the
   * crash qualification. A new database gets the journal and every migration; a database that has tables but no journal was not
   * created by NimbleNewt and is refused untouched; one from a newer version, or with an edited migration, is refused untouched.
   */
  #migrate(migrations: readonly Migration[]): void {
    this.#ordinal = 0;
    this.#inWrite = true;
    const at = (): string => new Date().toISOString();
    const exec = (sql: string): void => this.#step(sql, () => { this.#db.exec(sql); });
    const begin = (): void => exec("BEGIN IMMEDIATE");
    const commit = (): void => exec("COMMIT");
    try {
      // 1. The journal. A file with tables but no journal is somebody else's database.
      begin();
      try {
        const tables = (this.#get("SELECT name FROM sqlite_schema WHERE type = 'table' AND name NOT LIKE 'sqlite_%'") !== undefined);
        const journalExists = this.#get("SELECT 1 AS x FROM sqlite_schema WHERE type = 'table' AND name = 'schema_migrations'") !== undefined;
        if (!journalExists) {
          if (tables) throw new StorageError("unavailable", "the file has tables but no schema journal: either NimbleNewt did not create it, or it was created by a development build from before schema journals (card F04); recreate it. Nothing was changed.");
          exec(JOURNAL_SQL);
        }
        commit();
      } catch (error) {
        this.#rollback();
        throw error;
      }
      // 2. One migration per round, until none is left. Every round must make progress, so the loop is bounded: a migration whose journal
      // entry does not stick (for example, statements that delete it) would otherwise be planned again forever.
      for (let rounds = 1; ; rounds++) {
        if (rounds > migrations.length + 2) throw new StorageError("unavailable", "the schema migrations are not making progress: a migration was applied but the journal does not show it; stopping instead of repeating it forever");
        begin();
        let committed = false;
        try {
          const journal = this.#all("SELECT version, name, checksum, state FROM schema_migrations ORDER BY version").map((r): JournalEntry => ({ version: count(r, "version"), name: text(r, "name"), checksum: text(r, "checksum"), state: text(r, "state") as JournalEntry["state"] }));
          const plan = planMigrations(migrations, journal);
          const next = plan.resume ?? plan.pending[0];
          if (next === undefined) { commit(); committed = true; return; }
          const record = (state: "running" | "done"): void => {
            this.#run("INSERT INTO schema_migrations (version, name, checksum, state, started_at, finished_at) VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT (version) DO UPDATE SET state = excluded.state, finished_at = excluded.finished_at",
              next.version, next.name, migrationChecksum(next), state, at(), state === "done" ? at() : null);
          };
          if (next.transactional !== false) {
            // Statements and journal entry commit together: an interruption leaves the database exactly as it was.
            for (const statement of next.statements) exec(statement);
            record("done");
            commit(); committed = true;
            continue;
          }
          // Not transactional: journal it as running (committed), run its idempotent statements on their own, then mark it done.
          if (plan.resume === undefined) record("running");
          commit(); committed = true;
          for (const statement of next.statements) exec(statement);
          begin();
          this.#run("UPDATE schema_migrations SET state = 'done', finished_at = ? WHERE version = ?", at(), next.version);
          commit();
        } catch (error) {
          if (!committed) this.#rollback();
          throw error;
        }
      }
    } finally {
      this.#inWrite = false;
    }
  }

  /** The settings in force, read back from the database. */
  settings(): SqliteSettings {
    const one = (sql: string): Row => this.#db.prepare(sql).get() as Row;
    const sync = ["OFF", "NORMAL", "FULL", "EXTRA"][one("PRAGMA synchronous").synchronous as number] ?? "UNKNOWN";
    return {
      sqliteVersion: text(one("SELECT sqlite_version() AS v"), "v"),
      schemaVersion: count(one("SELECT count(*) AS n FROM sqlite_schema WHERE type = 'table' AND name = 'schema_migrations'"), "n") === 0 ? 0 : count(one("SELECT COALESCE(MAX(version), 0) AS v FROM schema_migrations WHERE state = 'done'"), "v"),
      journalMode: text(one("PRAGMA journal_mode"), "journal_mode"),
      synchronous: sync,
      foreignKeys: one("PRAGMA foreign_keys").foreign_keys === 1,
      busyTimeoutMs: this.#busyTimeoutMs,
    };
  }

  // ------------------------------------------------------------------------------------------ plumbing

  #sql(sql: string): StatementSync {
    let statement = this.#statements.get(sql);
    if (statement === undefined) {
      statement = this.#db.prepare(sql);
      this.#statements.set(sql, statement);
    }
    return statement;
  }
  /** Runs one numbered statement of a write transaction, with the test hooks around it. */
  #step<T>(sql: string, fn: () => T): T {
    if (this.#hook?.statement === undefined || !this.#inWrite) return fn();
    const ordinal = ++this.#ordinal;
    this.#hook.statement("before", sql, ordinal);
    const result = fn();
    this.#hook.statement("after", sql, ordinal);
    return result;
  }
  #get(sql: string, ...params: SQLInputValue[]): Row | undefined { return this.#step(sql, () => this.#sql(sql).get(...params) as Row | undefined); }
  #all(sql: string, ...params: SQLInputValue[]): Row[] { return this.#step(sql, () => this.#sql(sql).all(...params) as Row[]); }
  #run(sql: string, ...params: SQLInputValue[]): void { this.#step(sql, () => { this.#sql(sql).run(...params); }); }

  #usable(): void {
    if (this.#closed) throw new StorageError("unavailable", "the storage is closed");
  }

  /** Runs a read. */
  #read<T>(fn: () => T): T {
    this.#usable();
    try { return fn(); } catch (error) { throw classify(error); }
  }

  /**
   * Runs `fn` inside one `BEGIN IMMEDIATE` transaction. Any failure rolls everything back. A failure of the final COMMIT is
   * `retryable` when it was only lock contention; otherwise the outcome is unknown and is reported as `uncertain_commit`
   * (for the operation primitive) or `retryable` (for claims, which are safe to repeat because leases expire).
   */
  #writeTransaction<T>(fn: () => T, onUnknownCommit: "uncertain_commit" | "retryable"): T {
    this.#usable();
    this.#ordinal = 0;
    this.#inWrite = true;
    try {
      return this.#transaction(fn, onUnknownCommit);
    } finally {
      this.#inWrite = false;
    }
  }

  #transaction<T>(fn: () => T, onUnknownCommit: "uncertain_commit" | "retryable"): T {
    try {
      this.#step("BEGIN IMMEDIATE", () => this.#db.exec("BEGIN IMMEDIATE"));
    } catch (error) {
      throw classify(error);
    }
    let result: T;
    try {
      result = fn();
    } catch (error) {
      this.#rollback();
      throw classify(error);
    }
    try {
      this.#step("COMMIT", () => this.#db.exec("COMMIT"));
    } catch (error) {
      this.#rollback();
      if (isBusy(error)) throw classify(error);
      throw new StorageError(onUnknownCommit, `the commit failed and its outcome is unknown: ${error instanceof Error ? error.message : String(error)}`, { cause: error });
    }
    return result;
  }

  #rollback(): void {
    try { if (this.#db.isTransaction) this.#db.exec("ROLLBACK"); } catch { /* the connection is already unusable; the transaction is gone with it */ }
  }

  #fence(epoch: unknown): void {
    checkCount(epoch, "epoch", Number.MAX_SAFE_INTEGER, 1);
    const current = this.#currentEpoch();
    if (epoch !== current) throw new StorageError("stale_epoch", `call is for epoch ${epoch} but the current epoch is ${current}`);
  }
  #currentEpoch(): number { return count(this.#get("SELECT epoch FROM state WHERE singleton = 1")!, "epoch"); }

  // ------------------------------------------------------------------------------------------- epochs

  async currentEpoch(): Promise<number> {
    return this.#read(() => this.#currentEpoch());
  }

  async acquireEpoch(input: { holder: string; at: Timestamp; expectedEpoch?: number }): Promise<{ epoch: number }> {
    this.#usable();
    checkText(input.holder, "holder");
    checkTimestamp(input.at, "at");
    if (input.expectedEpoch !== undefined) checkCount(input.expectedEpoch, "expectedEpoch");
    return this.#writeTransaction(() => {
      const current = this.#currentEpoch();
      if (input.expectedEpoch !== undefined && input.expectedEpoch !== current) throw new StorageError("stale_epoch", `expected epoch ${input.expectedEpoch} but the current epoch is ${current}`);
      this.#run("UPDATE state SET epoch = ?, holder = ? WHERE singleton = 1", current + 1, input.holder);
      return { epoch: current + 1 };
    }, "retryable");
  }

  // --------------------------------------------------------------------------------- the write primitive

  async applyOperation(input: OperationInput): Promise<OperationResult> {
    this.#usable();
    validateOperation(input);
    const hash = operationHash(input);
    return this.#writeTransaction(() => this.#apply(input, hash), "uncertain_commit");
  }

  #apply(input: OperationInput, hash: string): OperationResult {
    const existing = this.#get("SELECT request_hash, result FROM operations WHERE operation_id = ?", input.operationId);
    if (existing !== undefined) {
      if (text(existing, "request_hash") !== hash) throw new StorageError("idempotency_conflict", `operation ${input.operationId} was already used with different content`);
      return { ...(parseJson(text(existing, "result")) as unknown as OperationResult), replayed: true };
    }
    const state = this.#get("SELECT epoch, audit_seq, delivery_seq FROM state WHERE singleton = 1")!;
    if (input.epoch !== count(state, "epoch")) throw new StorageError("stale_epoch", `operation is for epoch ${input.epoch} but the current epoch is ${count(state, "epoch")}`);

    // Check everything before writing anything.
    const revisions: { ref: AggregateRef; revision: number }[] = [];
    for (const [i, change] of input.changes.entries()) {
      const current = this.#get("SELECT revision FROM aggregates WHERE kind = ? AND id = ?", change.ref.kind, change.ref.id);
      const label = `${change.ref.kind}/${change.ref.id}`;
      if (change.type === "create") {
        if (current !== undefined) throw new StorageError("revision_conflict", `${label} already exists (changes[${i}])`);
        revisions.push({ ref: change.ref, revision: 1 });
      } else {
        if (current === undefined) throw new StorageError("not_found", `${label} does not exist (changes[${i}])`);
        if (count(current, "revision") !== change.expectedRevision) throw new StorageError("revision_conflict", `${label} is at revision ${count(current, "revision")}, expected ${change.expectedRevision} (changes[${i}])`);
        revisions.push({ ref: change.ref, revision: change.type === "update" ? change.expectedRevision + 1 : change.expectedRevision });
      }
    }
    for (const c of input.completeDeliveries) {
      const d = this.#get("SELECT state, token, receipt FROM deliveries WHERE delivery_id = ?", c.deliveryId);
      if (d === undefined) throw new StorageError("not_found", `delivery ${c.deliveryId} does not exist`);
      if (text(d, "state") === "delivered") {
        if (maybe(d, "receipt") !== canonicalJson(c.receipt)) throw new StorageError("state_conflict", `delivery ${c.deliveryId} was already delivered with a different receipt`);
      } else if (text(d, "state") !== "claimed" || maybe(d, "token") !== c.claimToken) throw new StorageError("state_conflict", `delivery ${c.deliveryId} is not held by this claim`);
    }
    for (const c of input.completeTimers) {
      const t = this.#get("SELECT state, token FROM timers WHERE timer_id = ?", c.timerId);
      if (t === undefined) throw new StorageError("not_found", `timer ${c.timerId} does not exist`);
      const repeat = text(t, "state") === "completed" && maybe(t, "token") === c.claimToken;
      if (!repeat && (text(t, "state") !== "claimed" || maybe(t, "token") !== c.claimToken)) throw new StorageError("state_conflict", `timer ${c.timerId} is not held by this claim`);
    }
    for (const c of input.settleEffects) {
      const e = this.#get("SELECT status FROM effects WHERE effect_id = ?", c.effectId);
      if (e === undefined) throw new StorageError("not_found", `effect ${c.effectId} does not exist`);
      const status = text(e, "status");
      if (status !== c.outcome && (status === "confirmed" || status === "failed")) throw new StorageError("state_conflict", `effect ${c.effectId} is already ${status}`);
    }
    for (const o of input.outbox) if (this.#get("SELECT 1 AS x FROM deliveries WHERE delivery_id = ?", o.deliveryId) !== undefined) throw new StorageError("duplicate_id", `delivery ${o.deliveryId} already exists`);
    for (const e of input.effects) if (this.#get("SELECT 1 AS x FROM effects WHERE effect_id = ?", e.effectId) !== undefined) throw new StorageError("duplicate_id", `effect ${e.effectId} already exists`);
    for (const t of input.timers) if (this.#get("SELECT 1 AS x FROM timers WHERE timer_id = ?", t.timerId) !== undefined) throw new StorageError("duplicate_id", `timer ${t.timerId} already exists`);

    // Compute the result first: the operation row must exist before rows that refer to it.
    let auditSeq = count(state, "audit_seq");
    const auditSeqs: number[] = [];
    const auditRows: { seq: number; type: string; subject?: AggregateRef; detail: string }[] = [];
    for (const a of input.audit) {
      auditSeq += 1;
      auditSeqs.push(auditSeq);
      auditRows.push({ seq: auditSeq, type: a.type, ...optional("subject", a.subject), detail: canonicalJson(a.detail) });
    }
    const settlements = input.settleEffects.map((c) => {
      const previous = text(this.#get("SELECT status FROM effects WHERE effect_id = ?", c.effectId)!, "status");
      auditSeq += 1;
      auditSeqs.push(auditSeq);
      auditRows.push({ seq: auditSeq, type: "effect.settled", subject: { kind: "effect", id: c.effectId }, detail: canonicalJson({ outcome: c.outcome, previous }) });
      return { ...c, previous };
    });
    const result: OperationResult = { operationId: input.operationId, replayed: false, revisions, auditSeqs, epoch: input.epoch };
    this.#run("INSERT INTO operations (operation_id, request_hash, actor, correlation_id, at, result) VALUES (?, ?, ?, ?, ?, ?)", input.operationId, hash, input.actor, input.correlationId, input.at, canonicalJson(result));

    for (const [i, change] of input.changes.entries()) {
      if (change.type === "check") continue;
      const revision = revisions[i]!.revision;
      if (change.type === "create") {
        this.#run("INSERT INTO aggregates (kind, id, revision, body, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)", change.ref.kind, change.ref.id, revision, canonicalJson(change.body), input.at, input.at);
      } else {
        this.#run("UPDATE aggregates SET revision = ?, body = ?, updated_at = ? WHERE kind = ? AND id = ?", revision, canonicalJson(change.body), input.at, change.ref.kind, change.ref.id);
      }
    }
    for (const a of auditRows) {
      this.#run("INSERT INTO audit (seq, operation_id, correlation_id, actor, at, type, subject_kind, subject_id, detail) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
        a.seq, input.operationId, input.correlationId, input.actor, input.at, a.type, a.subject?.kind ?? null, a.subject?.id ?? null, a.detail);
    }
    for (const s of settlements) {
      if (s.previous === s.outcome) continue;
      this.#run("UPDATE effects SET status = ?, updated_at = ?, evidence = COALESCE(?, evidence) WHERE effect_id = ?", s.outcome, input.at, s.evidence === undefined ? null : canonicalJson(s.evidence), s.effectId);
    }
    for (const c of input.completeDeliveries) {
      this.#run("UPDATE deliveries SET state = 'delivered', receipt = ?, delivered_at = ?, claimed_until = NULL WHERE delivery_id = ? AND state <> 'delivered'", canonicalJson(c.receipt), input.at, c.deliveryId);
    }
    for (const c of input.completeTimers) {
      this.#run("UPDATE timers SET state = 'completed', claimed_until = NULL WHERE timer_id = ? AND state <> 'completed'", c.timerId);
    }
    let deliverySeq = count(state, "delivery_seq");
    for (const o of input.outbox) {
      deliverySeq += 1;
      const revision = revisions.find((r) => r.ref.kind === o.aggregate.kind && r.ref.id === o.aggregate.id)!.revision;
      this.#run("INSERT INTO deliveries (delivery_id, seq, destination, ordering_key, priority, aggregate_kind, aggregate_id, aggregate_revision, payload, state, attempts, next_attempt_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', 0, ?)",
        o.deliveryId, deliverySeq, o.destination, o.orderingKey ?? null, o.priority, o.aggregate.kind, o.aggregate.id, revision, canonicalJson(o.payload), o.notBefore ?? input.at);
    }
    for (const e of input.effects) {
      this.#run("INSERT INTO effects (effect_id, operation_id, attempt_id, target, input_digest, reconciliation_handle, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, 'intended', ?, ?)",
        e.effectId, input.operationId, e.attemptId ?? null, e.target, e.inputDigest, e.reconciliationHandle ?? null, input.at, input.at);
    }
    for (const t of input.timers) {
      this.#run("INSERT INTO timers (timer_id, due_at, aggregate_kind, aggregate_id, payload, state, attempts) VALUES (?, ?, ?, ?, ?, 'pending', 0)", t.timerId, t.dueAt, t.aggregate?.kind ?? null, t.aggregate?.id ?? null, canonicalJson(t.payload));
    }
    for (const id of input.cancelTimers) this.#run("UPDATE timers SET state = 'cancelled' WHERE timer_id = ? AND state IN ('pending', 'claimed')", id);
    if (auditSeq !== count(state, "audit_seq") || deliverySeq !== count(state, "delivery_seq")) {
      this.#run("UPDATE state SET audit_seq = ?, delivery_seq = ? WHERE singleton = 1", auditSeq, deliverySeq);
    }
    return result;
  }

  async getOperation(operationId: Id): Promise<StoredOperation | undefined> {
    checkId(operationId, "operationId");
    return this.#read(() => {
      const row = this.#get("SELECT request_hash, actor, correlation_id, at, result FROM operations WHERE operation_id = ?", operationId);
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
    return this.#read(() => {
      const row = this.#get("SELECT kind, id, revision, body, created_at, updated_at FROM aggregates WHERE kind = ? AND id = ?", ref.kind, ref.id);
      return row === undefined ? undefined : this.#aggregate(row);
    });
  }

  async listAggregates(kind: string, page: Page): Promise<Aggregate[]> {
    checkKind(kind, "kind");
    checkPage(page);
    return this.#read(() => this.#all("SELECT kind, id, revision, body, created_at, updated_at FROM aggregates WHERE kind = ? AND id > ? ORDER BY id LIMIT ?", kind, page.afterId ?? "", page.limit).map((r) => this.#aggregate(r)));
  }

  async listAudit(input: { afterSeq: number; limit: number }): Promise<AuditRecord[]> {
    checkCount(input.afterSeq, "afterSeq");
    checkCount(input.limit, "limit", 1000, 1);
    return this.#read(() => this.#all("SELECT seq, operation_id, correlation_id, actor, at, type, subject_kind, subject_id, detail FROM audit WHERE seq > ? ORDER BY seq LIMIT ?", input.afterSeq, input.limit).map((r) => ({
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
    return this.#writeTransaction(() => {
      this.#fence(input.epoch);
      const chosen = this.#all(
        `SELECT d.delivery_id FROM deliveries d
         WHERE d.destination = ? AND d.state <> 'delivered' AND (d.state = 'pending' OR d.claimed_until <= ?) AND d.next_attempt_at <= ?
           AND (d.ordering_key IS NULL OR NOT EXISTS (
             SELECT 1 FROM deliveries e WHERE e.destination = d.destination AND e.ordering_key = d.ordering_key AND e.state <> 'delivered' AND e.seq < d.seq))
         ORDER BY d.priority DESC, d.seq ASC LIMIT ?`, input.destination, input.now, input.now, input.limit);
      const until = plus(input.now, input.leaseMs);
      return chosen.map((c) => {
        const id = text(c, "delivery_id");
        this.#run("UPDATE deliveries SET state = 'claimed', attempts = attempts + 1, claimed_until = ?, token = delivery_id || '#' || (attempts + 1) WHERE delivery_id = ?", until, id);
        const d = this.#get("SELECT delivery_id, token, attempts, destination, ordering_key, priority, aggregate_kind, aggregate_id, aggregate_revision, payload, claimed_until FROM deliveries WHERE delivery_id = ?", id)!;
        return {
          deliveryId: id, claimToken: text(d, "token"), attempt: count(d, "attempts"), destination: text(d, "destination"), ...optional("orderingKey", maybe(d, "ordering_key")), priority: count(d, "priority"),
          aggregate: { kind: text(d, "aggregate_kind"), id: text(d, "aggregate_id") }, aggregateRevision: count(d, "aggregate_revision"), payload: parseJson(text(d, "payload")) as JsonObject, claimedUntil: text(d, "claimed_until"),
        };
      });
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
    this.#writeTransaction(() => {
      this.#fence(input.epoch);
      const d = this.#get("SELECT state, token FROM deliveries WHERE delivery_id = ?", input.deliveryId);
      if (d === undefined) throw new StorageError("not_found", `delivery ${input.deliveryId} does not exist`);
      if (text(d, "state") !== "claimed" || maybe(d, "token") !== input.claimToken) throw new StorageError("state_conflict", `delivery ${input.deliveryId} is not held by this claim`);
      this.#run("UPDATE deliveries SET state = 'pending', next_attempt_at = ?, last_error = ?, claimed_until = NULL WHERE delivery_id = ?", input.nextAttemptAt, input.reason, input.deliveryId);
    }, "retryable");
  }

  async getDelivery(deliveryId: Id): Promise<DeliveryRecord | undefined> {
    checkId(deliveryId, "deliveryId");
    return this.#read(() => {
      const d = this.#get("SELECT * FROM deliveries WHERE delivery_id = ?", deliveryId);
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
    return this.#read(() => {
      const e = this.#get("SELECT * FROM effects WHERE effect_id = ?", effectId);
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
    return this.#writeTransaction(() => {
      this.#fence(input.epoch);
      const due = this.#all("SELECT timer_id FROM timers WHERE (state = 'pending' OR (state = 'claimed' AND claimed_until <= ?)) AND due_at <= ? ORDER BY due_at, timer_id LIMIT ?", input.now, input.now, input.limit);
      const until = plus(input.now, input.leaseMs);
      return due.map((row) => {
        const id = text(row, "timer_id");
        this.#run("UPDATE timers SET state = 'claimed', attempts = attempts + 1, claimed_until = ?, token = timer_id || '#' || (attempts + 1) WHERE timer_id = ?", until, id);
        const t = this.#get("SELECT timer_id, token, attempts, due_at, aggregate_kind, aggregate_id, payload, claimed_until FROM timers WHERE timer_id = ?", id)!;
        return {
          timerId: id, claimToken: text(t, "token"), attempt: count(t, "attempts"), dueAt: text(t, "due_at"),
          ...(t.aggregate_kind === null ? {} : { aggregate: { kind: text(t, "aggregate_kind"), id: text(t, "aggregate_id") } }), payload: parseJson(text(t, "payload")) as JsonObject, claimedUntil: text(t, "claimed_until"),
        };
      });
    }, "retryable");
  }

  async getTimer(timerId: Id): Promise<TimerRecord | undefined> {
    checkId(timerId, "timerId");
    return this.#read(() => {
      const t = this.#get("SELECT * FROM timers WHERE timer_id = ?", timerId);
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
    this.#statements.clear();
    this.#db.close();
  }
}
