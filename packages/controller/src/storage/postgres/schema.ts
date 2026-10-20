import { assertValidMigrations, type Migration } from "../migrations.js";

/**
 * The PostgreSQL schema of the controller store as an ordered list of journaled migrations (see `../migrations.ts` for the rules),
 * created inside a dedicated schema (default `nimblenewt`). Migration 1 creates the first layout, with the same promises as the SQLite
 * layout, enforced by the database as well: unique operation, delivery, effect and timer IDs are primary keys; sequence numbers are
 * unique; states are checked. Every text column that is compared or ordered uses the binary `"C"` collation, so ordering is by code
 * point whatever the server's locale. Bodies are canonical JSON stored as `text` (not `json`/`jsonb`) so the text and the request hash
 * round-trip byte for byte.
 */
const T = 'text COLLATE "C"';

const INITIAL_SQL = `
CREATE TABLE state (
  singleton integer PRIMARY KEY CHECK (singleton = 1),
  epoch bigint NOT NULL CHECK (epoch >= 0),
  holder ${T}
);
INSERT INTO state (singleton, epoch, holder) VALUES (1, 0, NULL);

CREATE TABLE counters (
  singleton integer PRIMARY KEY CHECK (singleton = 1),
  audit_seq bigint NOT NULL CHECK (audit_seq >= 0),
  delivery_seq bigint NOT NULL CHECK (delivery_seq >= 0)
);
INSERT INTO counters (singleton, audit_seq, delivery_seq) VALUES (1, 0, 0);

CREATE TABLE aggregates (
  kind ${T} NOT NULL,
  id ${T} NOT NULL,
  revision bigint NOT NULL CHECK (revision >= 1),
  body ${T} NOT NULL,
  created_at ${T} NOT NULL,
  updated_at ${T} NOT NULL,
  PRIMARY KEY (kind, id)
);

CREATE TABLE operations (
  operation_id ${T} PRIMARY KEY,
  request_hash ${T} NOT NULL,
  actor ${T} NOT NULL,
  correlation_id ${T} NOT NULL,
  at ${T} NOT NULL,
  result ${T} NOT NULL
);

CREATE TABLE audit (
  seq bigint PRIMARY KEY,
  operation_id ${T} NOT NULL REFERENCES operations (operation_id),
  correlation_id ${T} NOT NULL,
  actor ${T} NOT NULL,
  at ${T} NOT NULL,
  type ${T} NOT NULL,
  subject_kind ${T},
  subject_id ${T},
  detail ${T} NOT NULL
);

CREATE TABLE deliveries (
  delivery_id ${T} PRIMARY KEY,
  seq bigint NOT NULL UNIQUE,
  destination ${T} NOT NULL,
  ordering_key ${T},
  priority integer NOT NULL CHECK (priority BETWEEN 0 AND 9),
  aggregate_kind ${T} NOT NULL,
  aggregate_id ${T} NOT NULL,
  aggregate_revision bigint NOT NULL,
  payload ${T} NOT NULL,
  state ${T} NOT NULL CHECK (state IN ('pending', 'claimed', 'delivered')),
  attempts integer NOT NULL CHECK (attempts >= 0),
  next_attempt_at ${T} NOT NULL,
  claimed_until ${T},
  token ${T},
  last_error ${T},
  receipt ${T},
  delivered_at ${T}
);
CREATE INDEX deliveries_open ON deliveries (destination, next_attempt_at, priority DESC, seq) WHERE state <> 'delivered';
CREATE INDEX deliveries_open_key ON deliveries (destination, ordering_key, seq) WHERE state <> 'delivered' AND ordering_key IS NOT NULL;

CREATE TABLE effects (
  effect_id ${T} PRIMARY KEY,
  operation_id ${T} NOT NULL REFERENCES operations (operation_id),
  attempt_id ${T},
  target ${T} NOT NULL,
  input_digest ${T} NOT NULL,
  reconciliation_handle ${T},
  status ${T} NOT NULL CHECK (status IN ('intended', 'uncertain', 'confirmed', 'failed')),
  evidence ${T},
  created_at ${T} NOT NULL,
  updated_at ${T} NOT NULL
);

CREATE TABLE timers (
  timer_id ${T} PRIMARY KEY,
  due_at ${T} NOT NULL,
  aggregate_kind ${T},
  aggregate_id ${T},
  payload ${T} NOT NULL,
  state ${T} NOT NULL CHECK (state IN ('pending', 'claimed', 'completed', 'cancelled')),
  attempts integer NOT NULL CHECK (attempts >= 0),
  claimed_until ${T},
  token ${T}
);
CREATE INDEX timers_open ON timers (due_at, timer_id) WHERE state IN ('pending', 'claimed');
`;

/** The journal of applied migrations. Created by the runner itself before any migration runs; not part of migration 1. */
export const JOURNAL_SQL = `CREATE TABLE IF NOT EXISTS schema_migrations (
  version integer PRIMARY KEY CHECK (version >= 1),
  name ${T} NOT NULL,
  checksum ${T} NOT NULL,
  state ${T} NOT NULL CHECK (state IN ('running', 'done')),
  started_at ${T} NOT NULL,
  finished_at ${T}
)`;

/** The statements of a SQL script, one per entry (the script has no semicolons inside strings). */
const split = (script: string): string[] => script.split(/;\s*\n/).map((statement) => statement.trim().replace(/;$/, "")).filter((statement) => statement !== "");

/** The migrations this version of NimbleNewt applies to a PostgreSQL controller database. */
export const MIGRATIONS: readonly Migration[] = [{ version: 1, name: "initial_layout", statements: split(INITIAL_SQL) }];
assertValidMigrations(MIGRATIONS);

/** The newest layout this version knows. */
export const LATEST_VERSION = MIGRATIONS.length;
