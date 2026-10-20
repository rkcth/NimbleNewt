import { assertValidMigrations, type Migration } from "../migrations.js";

/**
 * The SQLite schema of the controller store as an ordered list of journaled migrations (see `../migrations.ts` for the rules).
 * Migration 1 creates the first layout. Everything the contract promises is enforced here as well as in code: unique operation,
 * delivery, effect and timer IDs are primary keys; sequence numbers are unique; states are checked. Text columns use SQLite's default
 * BINARY collation, which orders by UTF-8 bytes and so by code point, as the contract requires. Bodies are canonical JSON text.
 */
const INITIAL_SQL = `
CREATE TABLE state (
  singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
  epoch INTEGER NOT NULL CHECK (epoch >= 0),
  holder TEXT,
  audit_seq INTEGER NOT NULL CHECK (audit_seq >= 0),
  delivery_seq INTEGER NOT NULL CHECK (delivery_seq >= 0)
) STRICT;
INSERT INTO state (singleton, epoch, holder, audit_seq, delivery_seq) VALUES (1, 0, NULL, 0, 0);

CREATE TABLE aggregates (
  kind TEXT NOT NULL,
  id TEXT NOT NULL,
  revision INTEGER NOT NULL CHECK (revision >= 1),
  body TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (kind, id)
) STRICT, WITHOUT ROWID;

CREATE TABLE operations (
  operation_id TEXT PRIMARY KEY,
  request_hash TEXT NOT NULL,
  actor TEXT NOT NULL,
  correlation_id TEXT NOT NULL,
  at TEXT NOT NULL,
  result TEXT NOT NULL
) STRICT, WITHOUT ROWID;

CREATE TABLE audit (
  seq INTEGER PRIMARY KEY,
  operation_id TEXT NOT NULL REFERENCES operations (operation_id),
  correlation_id TEXT NOT NULL,
  actor TEXT NOT NULL,
  at TEXT NOT NULL,
  type TEXT NOT NULL,
  subject_kind TEXT,
  subject_id TEXT,
  detail TEXT NOT NULL
) STRICT;

CREATE TABLE deliveries (
  delivery_id TEXT PRIMARY KEY,
  seq INTEGER NOT NULL UNIQUE,
  destination TEXT NOT NULL,
  ordering_key TEXT,
  priority INTEGER NOT NULL CHECK (priority BETWEEN 0 AND 9),
  aggregate_kind TEXT NOT NULL,
  aggregate_id TEXT NOT NULL,
  aggregate_revision INTEGER NOT NULL,
  payload TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('pending', 'claimed', 'delivered')),
  attempts INTEGER NOT NULL CHECK (attempts >= 0),
  next_attempt_at TEXT NOT NULL,
  claimed_until TEXT,
  token TEXT,
  last_error TEXT,
  receipt TEXT,
  delivered_at TEXT
) STRICT, WITHOUT ROWID;
CREATE INDEX deliveries_open ON deliveries (destination, state, next_attempt_at, priority, seq) WHERE state <> 'delivered';
CREATE INDEX deliveries_open_key ON deliveries (destination, ordering_key, seq) WHERE state <> 'delivered' AND ordering_key IS NOT NULL;

CREATE TABLE effects (
  effect_id TEXT PRIMARY KEY,
  operation_id TEXT NOT NULL REFERENCES operations (operation_id),
  attempt_id TEXT,
  target TEXT NOT NULL,
  input_digest TEXT NOT NULL,
  reconciliation_handle TEXT,
  status TEXT NOT NULL CHECK (status IN ('intended', 'uncertain', 'confirmed', 'failed')),
  evidence TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
) STRICT, WITHOUT ROWID;

CREATE TABLE timers (
  timer_id TEXT PRIMARY KEY,
  due_at TEXT NOT NULL,
  aggregate_kind TEXT,
  aggregate_id TEXT,
  payload TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('pending', 'claimed', 'completed', 'cancelled')),
  attempts INTEGER NOT NULL CHECK (attempts >= 0),
  claimed_until TEXT,
  token TEXT
) STRICT, WITHOUT ROWID;
CREATE INDEX timers_open ON timers (due_at, timer_id) WHERE state IN ('pending', 'claimed');
`;

/** The journal of applied migrations. Created by the runner itself before any migration runs; not part of migration 1. */
export const JOURNAL_SQL = `CREATE TABLE IF NOT EXISTS schema_migrations (
  version INTEGER PRIMARY KEY CHECK (version >= 1),
  name TEXT NOT NULL,
  checksum TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('running', 'done')),
  started_at TEXT NOT NULL,
  finished_at TEXT
) STRICT`;

/** The statements of a SQL script, one per entry (the script has no semicolons inside strings). */
const split = (script: string): string[] => script.split(/;\s*\n/).map((statement) => statement.trim().replace(/;$/, "")).filter((statement) => statement !== "");

/** The migrations this version of NimbleNewt applies to a SQLite controller database. */
export const MIGRATIONS: readonly Migration[] = [{ version: 1, name: "initial_layout", statements: split(INITIAL_SQL) }];
assertValidMigrations(MIGRATIONS);

/** The newest layout this version knows. */
export const LATEST_VERSION = MIGRATIONS.length;
