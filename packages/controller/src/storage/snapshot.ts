import { StorageError } from "./errors.js";

/**
 * The logical form of a consistent copy of a controller store (card K01), the same for every backend: the tables of the store, each row an object of its columns (text, whole numbers or null).
 * Bodies stay the canonical JSON text they were stored as, so a copy restored on another backend reads back byte for byte. `state` is one row whatever the backend (PostgreSQL keeps the counters in a table of their own).
 * The order is the order a restore writes in: operations before the audit records and effects that name them, and `state` last (it is what makes the store look used).
 */
export const SNAPSHOT_TABLES = ["operations", "aggregates", "audit", "deliveries", "effects", "timers", "state"] as const;
export type SnapshotTable = (typeof SNAPSHOT_TABLES)[number];
export type SnapshotRow = { readonly [column: string]: string | number | null };

interface TableSpec { readonly columns: readonly string[]; readonly key: readonly string[]; readonly required: readonly string[]; readonly whole: readonly string[] }

export const TABLE_SPECS: Readonly<Record<SnapshotTable, TableSpec>> = {
  state: { columns: ["epoch", "holder", "audit_seq", "delivery_seq"], key: [], required: ["epoch", "audit_seq", "delivery_seq"], whole: ["epoch", "audit_seq", "delivery_seq"] },
  operations: { columns: ["operation_id", "request_hash", "actor", "correlation_id", "at", "result"], key: ["operation_id"], required: ["operation_id", "request_hash", "actor", "correlation_id", "at", "result"], whole: [] },
  aggregates: { columns: ["kind", "id", "revision", "body", "created_at", "updated_at"], key: ["kind", "id"], required: ["kind", "id", "revision", "body", "created_at", "updated_at"], whole: ["revision"] },
  audit: { columns: ["seq", "operation_id", "correlation_id", "actor", "at", "type", "subject_kind", "subject_id", "detail"], key: ["seq"], required: ["seq", "operation_id", "correlation_id", "actor", "at", "type", "detail"], whole: ["seq"] },
  deliveries: {
    columns: ["delivery_id", "seq", "destination", "ordering_key", "priority", "aggregate_kind", "aggregate_id", "aggregate_revision", "payload", "state", "attempts", "next_attempt_at", "claimed_until", "token", "last_error", "receipt", "delivered_at"],
    key: ["delivery_id"], required: ["delivery_id", "seq", "destination", "priority", "aggregate_kind", "aggregate_id", "aggregate_revision", "payload", "state", "attempts", "next_attempt_at"], whole: ["seq", "priority", "aggregate_revision", "attempts"],
  },
  effects: {
    columns: ["effect_id", "operation_id", "attempt_id", "target", "input_digest", "reconciliation_handle", "status", "evidence", "created_at", "updated_at"],
    key: ["effect_id"], required: ["effect_id", "operation_id", "target", "input_digest", "status", "created_at", "updated_at"], whole: [],
  },
  timers: { columns: ["timer_id", "due_at", "aggregate_kind", "aggregate_id", "payload", "state", "attempts", "claimed_until", "token"], key: ["timer_id"], required: ["timer_id", "due_at", "payload", "state", "attempts"], whole: ["attempts"] },
};

/** A consistent view of the store as of one moment, read a page at a time while the store goes on being used. */
export interface StorageSnapshot {
  /** The schema version the rows are in. A copy restores only into a store of the same version. */
  readonly schemaVersion: number;
  /** Rows of `table` in key order after the row `after` (its key columns are used), at most `limit`. `state` has one row and no key. */
  read(table: SnapshotTable, page: { after?: SnapshotRow; limit: number }): Promise<SnapshotRow[]>;
  /** Lets the copy go. */
  close(): Promise<void>;
}

export const SNAPSHOT_PAGE_MAX = 1000;

/** Refuses a row that is not exactly the table's columns with values of the right kind: the restore writes only what it understood. */
export function checkSnapshotRow(table: SnapshotTable, row: unknown): SnapshotRow {
  const spec = TABLE_SPECS[table];
  if (row === null || typeof row !== "object" || Array.isArray(row)) throw new StorageError("invalid_input", `${table}: a row must be an object`, { path: table });
  const record = row as Record<string, unknown>;
  for (const key of Object.keys(record)) if (!spec.columns.includes(key)) throw new StorageError("invalid_input", `${table}: unknown column ${JSON.stringify(key.slice(0, 40))}`, { path: table });
  const out: Record<string, string | number | null> = {};
  for (const column of spec.columns) {
    const value = record[column] ?? null;
    if (value === null) {
      if (spec.required.includes(column)) throw new StorageError("invalid_input", `${table}.${column}: is required`, { path: `${table}.${column}` });
    } else if (spec.whole.includes(column)) {
      if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) throw new StorageError("invalid_input", `${table}.${column}: must be a whole number`, { path: `${table}.${column}` });
    } else if (typeof value !== "string") {
      throw new StorageError("invalid_input", `${table}.${column}: must be text`, { path: `${table}.${column}` });
    }
    out[column] = value as string | number | null;
  }
  return out;
}

/** The text that keeps a row's place in its table (its key columns), for a page that continues after it. */
export const keyOf = (table: SnapshotTable, row: SnapshotRow): readonly (string | number)[] => TABLE_SPECS[table].key.map((column) => row[column] as string | number);
