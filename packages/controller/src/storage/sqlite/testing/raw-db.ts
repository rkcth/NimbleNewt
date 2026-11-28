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

/** The store tables a whole-store digest must find (the schema's own); any other table in the file is covered as well. */
const STORE_TABLES = ["state", "aggregates", "operations", "audit", "deliveries", "effects", "timers"] as const;

/**
 * An outside reader of a controller database (card G08): every row of every table in the file (read from SQLite's own catalogue, so a table added later is covered too), hashed, read on a read-only connection of its own, so no controller
 * code is asked. Rows are compared as text in a sorted order of their own, so the digest does not depend on the order SQLite returns them in. Two equal digests mean nothing in the database changed between them. A file that lacks one of
 * the store's tables throws: a digest of the wrong file would prove nothing.
 */
export function storeDigest(path: string): { readonly digest: string; readonly rows: number; readonly tables: readonly string[] } {
  const db = new DatabaseSync(path, { readOnly: true });
  try {
    const tables = (db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name").all() as { name: string }[]).map((r) => r.name);
    const missing = STORE_TABLES.filter((t) => !tables.includes(t));
    if (missing.length > 0) throw new Error(`not a controller store: no table ${missing.join(", ")}`);
    const hash = createHash("sha256");
    let rows = 0;
    for (const table of tables) {
      const texts = db.prepare(`SELECT * FROM "${table.replace(/"/g, '""')}"`).all().map((row) => JSON.stringify(row, (_k, v: unknown) => (typeof v === "bigint" ? `${v}n` : v instanceof Uint8Array ? Buffer.from(v).toString("base64") : v))).sort();
      hash.update(`${table}\n${texts.length}\n`);
      for (const text of texts) { hash.update(`${text}\n`); rows += 1; }
    }
    return { digest: hash.digest("hex"), rows, tables };
  } finally { db.close(); }
}
