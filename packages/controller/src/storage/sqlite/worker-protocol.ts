import type { StorageErrorKind } from "../errors.js";
import type { Migration } from "../migrations.js";
import type { SqliteOptions } from "./storage.js";

/** The storage methods the worker answers; anything else is refused. */
export const METHODS: ReadonlySet<string> = new Set([
  "currentEpoch", "acquireEpoch", "applyOperation", "getOperation", "getAggregate", "listAggregates", "listAudit", "claimDeliveries",
  "retryDelivery", "getDelivery", "getEffect", "claimDueTimers", "getTimer", "settings", "vacuumInto", "restoreRows", "close",
]);
/** Answered by the worker itself, only when a crash plan was given: the highest numbered statement seen in a write since the store opened. */
export const TEST_STATEMENT_COUNT = "testStatementCount";

/** Settings that can cross the thread boundary. The functions of `SqliteOptions` (test hooks) cannot, so crash plans are data. */
export type WorkerStorageOptions = Omit<SqliteOptions, "testHooks" | "migrations" | "beforeUpgrade"> & { readonly migrations?: readonly Migration[] };

/** For the crash qualification only: stop at an exact numbered statement of a write, after the store has opened. */
export interface TestCrash {
  readonly when: "before" | "after";
  readonly ordinal: number;
  /** `kill`: SIGKILL the whole process. `exit`: end only the worker thread. `count`: never stop; only count statements. */
  readonly mode: "kill" | "exit" | "count";
}

export interface WorkerInit { readonly options: WorkerStorageOptions; readonly testCrash?: TestCrash }
export interface WorkerRequest { readonly id: number; readonly method: string; readonly args: readonly unknown[] }
export interface WireError { readonly kind: StorageErrorKind; readonly message: string; readonly path?: string }
export type WorkerReply =
  | { readonly type: "ready"; readonly path: string }
  | { readonly type: "failed"; readonly error: WireError }
  | { readonly id: number; readonly ok: true; readonly value: unknown }
  | { readonly id: number; readonly ok: false; readonly error: WireError };
