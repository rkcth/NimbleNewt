/**
 * Test helpers that open a SQLite file with the database driver directly. They live here, with the rest of the SQLite code, because
 * the package boundaries allow the driver only under storage/sqlite (card K05 re-check: the tests of a held or foreign database).
 */
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
