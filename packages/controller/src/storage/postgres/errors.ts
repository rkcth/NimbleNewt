import { StorageError } from "../errors.js";

interface PgLikeError extends Error { code?: string; severity?: string; detail?: string }

const CONNECTION_CODES = new Set(["ECONNRESET", "EPIPE", "ETIMEDOUT", "ECONNABORTED", "ENETRESET", "ENETUNREACH", "EHOSTUNREACH"]);
const CONNECTION_MESSAGE = /connection terminated|connection (?:closed|ended|lost)|client has encountered a connection error|socket hang up|read ECONNRESET|write EPIPE|server closed the connection|terminating connection/i;

/** True if the failure means the connection itself was lost (as opposed to the server answering with an error). */
export function isConnectionLoss(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  const code = (error as PgLikeError).code;
  if (code !== undefined) {
    if (CONNECTION_CODES.has(code)) return true;
    if (code.startsWith("08")) return true; // connection exception class
    if (code === "57P01" || code === "57P02" || code === "57P03") return true; // admin shutdown, crash shutdown, cannot connect now
    if (/^[A-Z0-9]{5}$/.test(code)) return false; // any other SQLSTATE is the server answering
  }
  return CONNECTION_MESSAGE.test(error.message);
}

/**
 * Turns anything thrown by the driver into the contract's classification, so no driver error escapes. `phase` says whether the
 * statement that failed was the final COMMIT, where a lost connection leaves the outcome unknown.
 * - deadlock (40P01), serialization failure (40001), lock timeout (55P03), statement timeout (57014), too many connections (53300),
 *   waiting too long for a pooled connection: `retryable` (the transaction was rolled back and can be rerun);
 * - a connection lost before COMMIT: `retryable` (the transaction never committed);
 * - a connection lost during COMMIT: `uncertain_commit` for the operation primitive, `retryable` for claims (safe to repeat);
 * - cannot reach the server, authentication or authorisation failure, missing database, constraint violation (an invariant
 *   the adapter should have checked itself), disk full, read-only, anything unknown: `unavailable`.
 */
export function classify(error: unknown, phase: "work" | "commit" = "work", onUnknownCommit: "uncertain_commit" | "retryable" = "retryable"): StorageError {
  if (error instanceof StorageError) return error;
  const e = error as PgLikeError;
  const code = e?.code;
  if (phase === "commit" && isConnectionLoss(error)) {
    return new StorageError(onUnknownCommit, `the connection was lost while committing, so the outcome is unknown: ${e.message}`, { cause: error });
  }
  if (code === "40P01" || code === "40001" || code === "55P03" || code === "57014" || code === "53300") {
    const why = ({ "40P01": "deadlock detected", "40001": "serialization failure", "55P03": "lock wait timed out", "57014": "statement timed out", "53300": "too many connections" } as Record<string, string>)[code]!;
    return new StorageError("retryable", `${why}; the transaction was rolled back: ${e.message}`, { cause: error });
  }
  if (e instanceof Error && /timeout exceeded when trying to connect|pool is exhausted|timed out waiting for a connection/i.test(e.message)) {
    return new StorageError("retryable", `no database connection became available in time (pool pressure): ${e.message}`, { cause: error });
  }
  if (isConnectionLoss(error)) return new StorageError("retryable", `the connection was lost before the transaction committed: ${e.message}`, { cause: error });
  if (code === "42501") return new StorageError("unavailable", `permission denied: the database user needs CREATE on the database to create the controller's schema, and full rights on that schema afterwards: ${e.message}`, { cause: error });
  if (code !== undefined && code.startsWith("23")) return new StorageError("unavailable", `invariant violation (adapter bug, schema drift or an outside writer; SQLSTATE ${code}): ${e.message}`, { cause: error });
  if (code === "ECONNREFUSED" || code === "ENOTFOUND" || code === "EAI_AGAIN") return new StorageError("unavailable", `cannot reach the database server: ${e.message}`, { cause: error });
  return new StorageError("unavailable", `database error${code === undefined ? "" : ` (${code})`}: ${e instanceof Error ? e.message : String(error)}`, { cause: error });
}
