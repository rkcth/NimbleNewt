/**
 * How storage failures are classified, identically for every adapter. Callers decide what to do from `kind` alone.
 *
 * - `invalid_input`: the request itself is malformed. Nothing was written. Fix the request.
 * - `idempotency_conflict`: the operation ID was used before with different content. Nothing was written.
 * - `revision_conflict`: an aggregate was not at the expected revision (or already exists, for `create`). Re-read and decide.
 * - `not_found`: an aggregate, delivery, effect or timer that must exist does not.
 * - `stale_epoch`: the caller is not the current primary. Stop writing.
 * - `duplicate_id`: a delivery, effect or timer ID is already taken by a different operation.
 * - `state_conflict`: the thing exists but is in a state that forbids the request (wrong claim token, contradicting a final
 *   effect outcome).
 * - `retryable`: the database rolled the whole transaction back (busy, deadlock, serialization failure). Rerun it.
 * - `uncertain_commit`: the outcome of `applyOperation` is unknown (connection lost during commit). Resolve by operation ID
 *   with `getOperation`; do not assume it failed.
 * - `unavailable`: the store cannot be used (closed, corrupt, unreachable) and retrying will not help soon.
 */
export type StorageErrorKind =
  | "invalid_input"
  | "idempotency_conflict"
  | "revision_conflict"
  | "not_found"
  | "stale_epoch"
  | "duplicate_id"
  | "state_conflict"
  | "retryable"
  | "uncertain_commit"
  | "unavailable";

export class StorageError extends Error {
  readonly kind: StorageErrorKind;
  /** Where in the request the problem is, for `invalid_input`. */
  readonly path: string | undefined;

  constructor(kind: StorageErrorKind, message: string, options: { path?: string; cause?: unknown } = {}) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = "StorageError";
    this.kind = kind;
    this.path = options.path;
  }
}

export const isStorageError = (error: unknown, kind?: StorageErrorKind): error is StorageError =>
  error instanceof StorageError && (kind === undefined || error.kind === kind);
