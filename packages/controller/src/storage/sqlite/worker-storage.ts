import { Worker } from "node:worker_threads";
import { StorageError } from "../errors.js";
import type {
  Aggregate, AggregateRef, AuditRecord, ControllerStorage, DeliveryClaim, DeliveryRecord, EffectRecord, Id, OperationInput, OperationResult, Page,
  StoredOperation, TimerClaim, TimerRecord, Timestamp,
} from "../types.js";
import type { SqliteSettings } from "./storage.js";
import type { TestCrash, WireError, WorkerInit, WorkerReply, WorkerRequest, WorkerStorageOptions } from "./worker-protocol.js";

export type { TestCrash, WorkerStorageOptions } from "./worker-protocol.js";

export interface SqliteWorkerOptions extends WorkerStorageOptions {
  /** For the crash qualification only: end the process or the worker at an exact statement of a write. Never set in production. */
  readonly testCrash?: TestCrash;
}

interface Pending { readonly method: string; readonly resolve: (value: unknown) => void; readonly reject: (error: unknown) => void }

const fromWire = (error: WireError): StorageError => new StorageError(error.kind, error.message, error.path === undefined ? {} : { path: error.path });

/**
 * The SQLite implementation of `ControllerStorage` with the database on its own thread (card F04f).
 *
 * The behaviour is `SqliteStorage`'s, unchanged: the same code runs on a worker thread and this class forwards each call to it as a
 * message and returns its answer. The point is the controller's event loop: a durable commit (`synchronous = FULL`) waits for the disk
 * for several milliseconds, and in-thread that stalled every other task, heartbeat and inquiry. Here the wait happens on the worker
 * thread. The durability settings are the same, and the same conformance, parity and crash-boundary suites run against it.
 *
 * - Calls are answered in the order they were made (one thread, one connection), like `SqliteStorage`.
 * - Requests and answers are copied between threads. Input that cannot be copied (a function, a symbol, a cyclic structure that the
 *   copy rejects) is refused here as `invalid_input` before anything is sent; the rest is validated by the storage as before.
 * - If the worker stops without being asked (a crash, `process.exit`, an uncaught error), a call that was waiting for
 *   `applyOperation` fails as `uncertain_commit` (resolve it by operation ID on a reopened store, exactly as for a lost connection),
 *   any other waiting call fails as `unavailable`, and so does every later call. The database file is consistent: what the worker had
 *   not committed is rolled back by SQLite when the file is next opened.
 * - The thread is released while idle, so an unclosed store does not keep the process alive; call `close()` as before.
 */
export class SqliteWorkerStorage implements ControllerStorage {
  readonly #worker: Worker;
  readonly #pending = new Map<number, Pending>();
  #next = 1;
  #stopped: StorageError | undefined;
  #closing = false;
  #closed: Promise<void> | undefined;
  readonly path: string;

  private constructor(worker: Worker, path: string) {
    this.#worker = worker;
    this.path = path;
    worker.on("message", (reply: WorkerReply) => this.#answer(reply));
    worker.on("error", (error) => this.#stop(`the storage worker failed: ${error instanceof Error ? error.message : String(error)}`));
    worker.on("exit", (code) => this.#stop(`the storage worker stopped (exit code ${code})`));
    worker.unref();
  }

  /** Starts the worker, which opens the database exactly as `SqliteStorage.open` does; a refusal comes back with its original kind. */
  static open(options: SqliteWorkerOptions): Promise<SqliteWorkerStorage> {
    const { testCrash, ...storageOptions } = options;
    const init: WorkerInit = { options: storageOptions, ...(testCrash === undefined ? {} : { testCrash }) };
    return new Promise((resolve, reject) => {
      let worker: Worker;
      try {
        worker = new Worker(new URL("./worker.js", import.meta.url), { workerData: init });
      } catch (error) {
        reject(error instanceof StorageError ? error : new StorageError("invalid_input", `the storage options cannot be sent to the storage worker: ${error instanceof Error ? error.message : String(error)}`));
        return;
      }
      const startup = (reply: WorkerReply): void => {
        if (!("type" in reply)) return;
        worker.off("message", startup);
        worker.off("error", failed);
        worker.off("exit", exited);
        if (reply.type === "ready") resolve(new SqliteWorkerStorage(worker, reply.path));
        else { reject(fromWire(reply.error)); void worker.terminate(); }
      };
      const failed = (error: unknown): void => { worker.off("message", startup); worker.off("exit", exited); reject(new StorageError("unavailable", `the storage worker could not start: ${error instanceof Error ? error.message : String(error)}`)); };
      const exited = (code: number): void => { worker.off("message", startup); worker.off("error", failed); reject(new StorageError("unavailable", `the storage worker stopped while starting (exit code ${code})`)); };
      worker.on("message", startup);
      worker.once("error", failed);
      worker.once("exit", exited);
    });
  }

  #answer(reply: WorkerReply): void {
    if (!("id" in reply)) return;
    const pending = this.#pending.get(reply.id);
    if (pending === undefined) return;
    this.#pending.delete(reply.id);
    if (this.#pending.size === 0) this.#worker.unref();
    if (reply.ok) pending.resolve(reply.value);
    else pending.reject(fromWire(reply.error));
  }

  /** The worker is gone. Settle every waiting call truthfully, and refuse everything after. */
  #stop(reason: string): void {
    if (this.#stopped !== undefined) return;
    this.#stopped = new StorageError("unavailable", this.#closing ? "the storage is closed" : reason);
    const waiting = [...this.#pending.values()];
    this.#pending.clear();
    for (const call of waiting) {
      call.reject(this.#closing || call.method !== "applyOperation"
        ? this.#stopped
        : new StorageError("uncertain_commit", `${reason}; the operation may or may not have committed: look it up by its operation ID on a reopened store`));
    }
  }

  #call<T>(method: string, ...args: unknown[]): Promise<T> {
    if (this.#stopped !== undefined) return Promise.reject(this.#stopped);
    const id = this.#next++;
    return new Promise<T>((resolve, reject) => {
      const request: WorkerRequest = { id, method, args };
      try {
        this.#worker.postMessage(request);
      } catch (error) {
        reject(new StorageError("invalid_input", `the request could not be sent to the storage worker (it must be plain data): ${error instanceof Error ? error.message : String(error)}`));
        return;
      }
      if (this.#pending.size === 0) this.#worker.ref(); // a waiting call must keep the process alive; an idle store must not
      this.#pending.set(id, { method, resolve: resolve as (value: unknown) => void, reject });
    });
  }

  /** For the crash qualification only (a crash plan must have been given): the highest numbered statement of any write so far. */
  testStatementCount(): Promise<number> { return this.#call("testStatementCount"); }
  settings(): Promise<SqliteSettings> { return this.#call("settings"); }
  currentEpoch(): Promise<number> { return this.#call("currentEpoch"); }
  acquireEpoch(input: { holder: string; at: Timestamp; expectedEpoch?: number }): Promise<{ epoch: number }> { return this.#call("acquireEpoch", input); }
  applyOperation(input: OperationInput): Promise<OperationResult> { return this.#call("applyOperation", input); }
  getOperation(operationId: Id): Promise<StoredOperation | undefined> { return this.#call("getOperation", operationId); }
  getAggregate(ref: AggregateRef): Promise<Aggregate | undefined> { return this.#call("getAggregate", ref); }
  listAggregates(kind: string, page: Page): Promise<Aggregate[]> { return this.#call("listAggregates", kind, page); }
  listAudit(input: { afterSeq: number; limit: number }): Promise<AuditRecord[]> { return this.#call("listAudit", input); }
  claimDeliveries(input: { epoch: number; destination: string; claimant: string; now: Timestamp; leaseMs: number; limit: number }): Promise<DeliveryClaim[]> { return this.#call("claimDeliveries", input); }
  retryDelivery(input: { epoch: number; deliveryId: Id; claimToken: string; nextAttemptAt: Timestamp; reason: string; at: Timestamp }): Promise<void> { return this.#call("retryDelivery", input); }
  getDelivery(deliveryId: Id): Promise<DeliveryRecord | undefined> { return this.#call("getDelivery", deliveryId); }
  getEffect(effectId: Id): Promise<EffectRecord | undefined> { return this.#call("getEffect", effectId); }
  claimDueTimers(input: { epoch: number; claimant: string; now: Timestamp; leaseMs: number; limit: number }): Promise<TimerClaim[]> { return this.#call("claimDueTimers", input); }
  getTimer(timerId: Id): Promise<TimerRecord | undefined> { return this.#call("getTimer", timerId); }

  /** Closes the database on the worker (after the calls already made have been answered), then ends the thread. Repeated and concurrent calls share one close. */
  close(): Promise<void> {
    return (this.#closed ??= this.#shutDown());
  }

  async #shutDown(): Promise<void> {
    if (this.#stopped !== undefined) { this.#closing = true; return; }
    try {
      await this.#call("close");
    } catch (error) {
      if (!(error instanceof StorageError && error.kind === "unavailable")) throw error; // a worker that died while closing is closed
    } finally {
      this.#closing = true;
      this.#stop("closed");
      await this.#worker.terminate();
    }
  }
}
