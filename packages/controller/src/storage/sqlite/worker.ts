// Entry point of the storage worker thread (card F04f). It owns the one SQLite connection and runs the ordinary `SqliteStorage`
// on it, one request at a time in arrival order, so every durable commit (`synchronous = FULL`, a flush to disk) blocks this thread
// and never the controller's event loop. `worker-storage.ts` is the only caller. Requests and answers are plain data.
import { parentPort, workerData } from "node:worker_threads";
import { StorageError } from "../errors.js";
import { classify } from "./errors.js";
import { SqliteStorage } from "./storage.js";
import type { WorkerInit, WorkerReply, WorkerRequest, WireError } from "./worker-protocol.js";
import { METHODS, TEST_STATEMENT_COUNT } from "./worker-protocol.js";

const port = parentPort;
if (port === null) throw new Error("worker.js must run as a worker thread");
const init = workerData as WorkerInit;

const wire = (error: unknown): WireError => {
  const e = error instanceof StorageError ? error : classify(error);
  return { kind: e.kind, message: e.message, ...(e.path === undefined ? {} : { path: e.path }) };
};
const send = (reply: WorkerReply): void => port.postMessage(reply);

let armed = false;
let statements = 0;
let storage: SqliteStorage;
try {
  const crash = init.testCrash;
  storage = await SqliteStorage.open({
    ...init.options,
    ...(crash === undefined ? {} : {
      testHooks: { statement: (phase, _sql, ordinal) => {
        if (!armed) return;
        statements = Math.max(statements, ordinal);
        if (crash.mode === "count" || phase !== crash.when || ordinal !== crash.ordinal) return;
        if (crash.mode === "kill") process.kill(process.pid, "SIGKILL"); // the whole process, as a power cut or `kill -9` would
        else process.exit(1); // only this worker thread: the controller must notice and report it
      } },
    }),
  });
  armed = true;
  send({ type: "ready", path: storage.path });
} catch (error) {
  send({ type: "failed", error: wire(error) });
  process.exit(0);
}

port.on("message", (request: WorkerRequest) => {
  void (async () => {
    const { id, method, args } = request;
    try {
      if (method === TEST_STATEMENT_COUNT && init.testCrash !== undefined) { send({ id, ok: true, value: statements }); return; }
      if (!METHODS.has(method)) throw new StorageError("invalid_input", `the storage worker has no method ${JSON.stringify(String(method).slice(0, 40))}`);
      const target = storage as unknown as Record<string, (...a: unknown[]) => unknown>;
      const value = await (target[method] as (...a: unknown[]) => unknown).apply(storage, args as unknown[]);
      send({ id, ok: true, value });
    } catch (error) {
      send({ id, ok: false, error: wire(error) });
    }
  })();
});
