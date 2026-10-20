import { StorageError, isStorageError } from "./errors.js";
import { operationHash } from "./hash.js";
import type { ControllerStorage, OperationInput, OperationResult } from "./types.js";

export interface CommitOptions {
  /** Total tries, including the first. Default 5. */
  readonly attempts?: number;
  /** Pause before retry number `attempt` (1-based). Default none; real callers pass jittered backoff. */
  readonly pause?: (attempt: number) => Promise<void>;
}

/**
 * The way domain services submit an operation. It reruns a transaction the database rolled back (`retryable`), and when a
 * commit's outcome is unknown (`uncertain_commit`) it resolves the question by the operation's stable ID instead of
 * assuming failure: if the operation is stored with the same hash, its stored result is returned with `replayed: true`;
 * if it is absent it is submitted again, which is safe because admission is idempotent. Every other error is final and is
 * rethrown unchanged. The retry budget is bounded; running out throws the last `retryable` or `uncertain_commit` error.
 */
export async function commitOperation(storage: ControllerStorage, input: OperationInput, options: CommitOptions = {}): Promise<OperationResult> {
  const attempts = options.attempts ?? 5;
  let last: unknown;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    if (attempt > 1) await options.pause?.(attempt - 1);
    try {
      return await storage.applyOperation(input);
    } catch (error) {
      last = error;
      if (isStorageError(error, "retryable")) continue;
      if (!isStorageError(error, "uncertain_commit")) throw error;
      try {
        const stored = await storage.getOperation(input.operationId);
        if (stored === undefined) continue;
        if (stored.requestHash !== operationHash(input)) {
          throw new StorageError("idempotency_conflict", `operation ${input.operationId} exists with different content`);
        }
        return { ...stored.result, replayed: true };
      } catch (inner) {
        if (isStorageError(inner, "retryable") || isStorageError(inner, "uncertain_commit")) { last = inner; continue; }
        throw inner;
      }
    }
  }
  throw last;
}
