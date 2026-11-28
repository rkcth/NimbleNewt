/**
 * Test helpers that open a SQLite file with the database driver directly. They live here, with the rest of the SQLite code, because
 * the package boundaries allow the driver only under storage/sqlite (card K05 re-check: the tests of a held or foreign database).
 */
import { createHash } from "node:crypto";
import { DatabaseSync } from "node:sqlite";

/** Hold the file locked exclusively, as another program would; call the returned function to let it go. */
export function holdDatabaseLocked(path: string): () => void {
  const db = new DatabaseSync(path);
  db.exec("PRAGMA locking_mode = EXCLUSIVE; BEGIN EXCLUSIVE");
  return () => { try { db.exec("ROLLBACK"); } finally { db.close(); } };
}

/** Make a database file that is not a controller database (it has a table, but not the controller's state table). */
export function makeForeignDatabase(path: string): void {
  const db = new DatabaseSync(path);
  try { db.exec("CREATE TABLE t (x)"); } finally { db.close(); }
}

/** The store tables a whole-store digest covers. */
const STORE_TABLES = ["state", "aggregates", "operations", "audit", "deliveries", "effects", "timers"] as const;

/**
 * An outside reader of a controller database (card G08): every row of every store table, hashed, read on a read-only connection of its own, so no controller code is asked. Two equal digests mean nothing in the store changed between them.
 */
export function storeDigest(path: string): { readonly digest: string; readonly rows: number } {
  const db = new DatabaseSync(path, { readOnly: true });
  try {
    const hash = createHash("sha256");
    let rows = 0;
    for (const table of STORE_TABLES) {
      for (const row of db.prepare(`SELECT * FROM ${table} ORDER BY 1, 2`).all()) { hash.update(`${table}\n${JSON.stringify(row)}\n`); rows += 1; }
    }
    return { digest: hash.digest("hex"), rows };
  } finally { db.close(); }
}
