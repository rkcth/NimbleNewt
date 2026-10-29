import { mkdtempSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import { StorageError } from "../errors.js";
import { SNAPSHOT_PAGE_MAX, TABLE_SPECS, type SnapshotRow, type SnapshotTable, type StorageSnapshot } from "../snapshot.js";
import { classify } from "./errors.js";

/** The folder a snapshot file is made in: next to the database, on the same disk, with a name that says what it is. The caller removes it with the snapshot. */
export const snapshotFolder = (databasePath: string): string => mkdtempSync(join(dirname(databasePath), ".nn-snapshot-"));

/** The statement that copies a live database into a new file as of one moment (`VACUUM INTO` reads under one transaction, so the copy is consistent while writers go on). */
export const vacuumIntoSql = (file: string): string => `VACUUM INTO '${file.replaceAll("'", "''")}'`;

const plain = (row: SnapshotRow): SnapshotRow => ({ ...row });

/** Reads a consistent copy that was made into `file` (its own read-only connection; the copy never changes). Closing it deletes `folder`. */
export function openFileSnapshot(file: string, folder: string): StorageSnapshot {
  let db: DatabaseSync;
  try { db = new DatabaseSync(file, { readOnly: true }); } catch (error) { rmSync(folder, { recursive: true, force: true }); throw classify(error); }
  const version = (db.prepare("SELECT MAX(version) AS v FROM schema_migrations WHERE state = 'done'").get() as { v: number | null } | undefined)?.v ?? 0;
  let closed = false;
  return {
    schemaVersion: version,
    async read(table: SnapshotTable, page: { after?: SnapshotRow; limit: number }): Promise<SnapshotRow[]> {
      if (closed) throw new StorageError("unavailable", "the snapshot is closed");
      if (!Number.isSafeInteger(page.limit) || page.limit < 1 || page.limit > SNAPSHOT_PAGE_MAX) throw new StorageError("invalid_input", `limit: must be a whole number from 1 to ${SNAPSHOT_PAGE_MAX}`, { path: "limit" });
      const spec = TABLE_SPECS[table];
      try {
        // Only the columns this database has: one from an older schema (read before an upgrade) lacks the newer ones, which come out absent.
        const have = new Set((db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]).map((c) => c.name));
        const columns = spec.columns.filter((c) => have.has(c)).join(", ");
        if (spec.key.length === 0) return (db.prepare(`SELECT ${columns} FROM ${table}`).all() as SnapshotRow[]).map(plain);
        const key = spec.key.join(", ");
        const params: SQLInputValue[] = [];
        let where = "";
        if (page.after !== undefined) { where = ` WHERE (${key}) > (${spec.key.map(() => "?").join(", ")})`; for (const k of spec.key) params.push(page.after[k] as SQLInputValue); }
        return (db.prepare(`SELECT ${columns} FROM ${table}${where} ORDER BY ${key} LIMIT ?`).all(...params, page.limit) as SnapshotRow[]).map(plain);
      } catch (error) { throw classify(error); }
    },
    async close(): Promise<void> {
      if (closed) return;
      closed = true;
      try { db.close(); } finally { rmSync(folder, { recursive: true, force: true }); }
    },
  };
}
