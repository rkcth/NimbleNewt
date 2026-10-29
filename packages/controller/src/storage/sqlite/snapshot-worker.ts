// Entry point of the snapshot worker thread (card K01f): opens its own read-only connection to the database file and copies it into a new file with `VACUUM INTO`, so a large copy runs on this thread and never stops the
// controller's event loop. The copy is consistent (a WAL reader sees the database as of the moment its read began). `snapshot.ts` is the only caller.
import { parentPort, workerData } from "node:worker_threads";
import { DatabaseSync } from "node:sqlite";
import { vacuumIntoSql } from "./snapshot.js";

const port = parentPort;
if (port === null) throw new Error("snapshot-worker.js must run as a worker thread");
const { database, file, busyTimeoutMs } = workerData as { database: string; file: string; busyTimeoutMs: number };
try {
  const db = new DatabaseSync(database, { readOnly: true, timeout: busyTimeoutMs });
  try { db.exec(vacuumIntoSql(file)); } finally { db.close(); }
  port.postMessage({ ok: true });
} catch (error) {
  port.postMessage({ ok: false, message: error instanceof Error ? error.message : String(error) });
}
