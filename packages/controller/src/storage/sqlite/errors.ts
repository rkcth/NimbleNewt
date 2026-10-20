import { StorageError } from "../errors.js";

/** The primary SQLite result codes this adapter classifies. */
const BUSY = 5;
const LOCKED = 6;
const CONSTRAINT = 19;

interface SqliteLikeError extends Error { code?: string; errcode?: number; errstr?: string }

const isSqliteError = (error: unknown): error is SqliteLikeError => error instanceof Error && (error as SqliteLikeError).code === "ERR_SQLITE_ERROR";

/**
 * Turns anything thrown by the database layer into the contract's classification, so no driver error escapes:
 * - busy or locked (another connection holds the write lock past the bounded timeout): `retryable`, the transaction was
 *   rolled back and can simply be rerun;
 * - a constraint violation: `unavailable`, reported as an invariant violation. Every write runs under `BEGIN IMMEDIATE`, which
 *   takes the database's only write lock before the adapter reads anything, so no other connection can have raced it to a
 *   unique key. A violation therefore means an adapter bug, schema drift, or another program writing the file, and rerunning
 *   would only repeat it; it fails fast with the extended result code instead of hiding behind `retryable`;
 * - anything else (I/O error, disk full, corruption, read-only file, not a database): `unavailable`.
 */
export function classify(error: unknown): StorageError {
  if (error instanceof StorageError) return error;
  if (isSqliteError(error)) {
    const primary = (error.errcode ?? 0) & 0xff;
    if (primary === BUSY || primary === LOCKED) return new StorageError("retryable", `the database is busy: ${error.message}`, { cause: error });
    if (primary === CONSTRAINT) return new StorageError("unavailable", `invariant violation (adapter bug, schema drift or an outside writer; extended code ${error.errcode ?? "?"}): ${error.message}`, { cause: error });
    return new StorageError("unavailable", `database error ${error.errstr ?? ""} (${error.errcode ?? "?"}): ${error.message}`, { cause: error });
  }
  return new StorageError("unavailable", `unexpected storage failure: ${error instanceof Error ? error.message : String(error)}`, { cause: error });
}

export const isBusy = (error: unknown): boolean => {
  if (!isSqliteError(error)) return false;
  const primary = (error.errcode ?? 0) & 0xff;
  return primary === BUSY || primary === LOCKED;
};
