import { DatabaseSync } from "node:sqlite";

/**
 * The epoch in a SQLite controller database's state row, read without opening it as a storage (no migration, no write of its own; card K05, second review: a staged restore prepared at another epoch is not swapped
 * in). Undefined when the file cannot be read as a controller database (a damaged database is what a restore is for). The caller checks that the file exists: opening a missing path would create it.
 */
export function readSqliteEpoch(path: string): number | undefined {
  try {
    // Not read-only: a read-only connection to a WAL database leaves its -wal and -shm files behind (it may not remove them), and a staged restore would then move those aside as the live database's
    // own. This connection only reads; as the last one to close it checkpoints and removes them, as the controller's own close does.
    const db = new DatabaseSync(path, { timeout: 2000 });
    try {
      const row = db.prepare("SELECT epoch FROM state LIMIT 1").get() as { epoch?: unknown } | undefined;
      const epoch = Number(row?.epoch);
      return row === undefined || !Number.isSafeInteger(epoch) ? undefined : epoch;
    } finally { db.close(); }
  } catch { return undefined; }
}
