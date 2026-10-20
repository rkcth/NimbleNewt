import type { Migration } from "../migrations.js";
import { MIGRATIONS as POSTGRES } from "../postgres/schema.js";
import { MIGRATIONS as SQLITE } from "../sqlite/schema.js";

/**
 * Synthetic later layouts, for qualifying the migration runners. The production lists have a single migration (the first layout
 * is the first), so every behaviour the runner promises for upgrades is tested here against additive migrations that the adapters
 * keep working with:
 * - v2 is transactional and changes data as well as structure: it adds a column, backfills it for existing rows, adds an index,
 *   and creates and fills a probe table with a non-idempotent insert (running it twice would fail), so any re-execution shows;
 * - v3 is not transactional (for PostgreSQL it builds an index CONCURRENTLY, which cannot run inside a transaction) and every one
 *   of its statements is idempotent, as the rules require.
 */
export type Dialect = "sqlite" | "postgres";
export type RegistryName = "v1" | "v12" | "v123" | "v123-with-v2-edited" | "v12-with-erasing-v3";

const v2 = (dialect: Dialect): Migration => ({
  version: 2,
  name: "add_note_and_probe",
  statements: dialect === "sqlite"
    ? [
      "ALTER TABLE aggregates ADD COLUMN note TEXT",
      "UPDATE aggregates SET note = 'migrated'",
      "CREATE INDEX aggregates_updated ON aggregates (updated_at)",
      "CREATE TABLE migration_probe (n INTEGER PRIMARY KEY) STRICT",
      "INSERT INTO migration_probe (n) VALUES (2)",
    ]
    : [
      'ALTER TABLE aggregates ADD COLUMN note text COLLATE "C"',
      "UPDATE aggregates SET note = 'migrated'",
      "CREATE INDEX aggregates_updated ON aggregates (updated_at)",
      "CREATE TABLE migration_probe (n integer PRIMARY KEY)",
      "INSERT INTO migration_probe (n) VALUES (2)",
    ],
});

const v3 = (dialect: Dialect): Migration => ({
  version: 3,
  name: "audit_type_index_and_notes",
  transactional: false,
  statements: dialect === "sqlite"
    ? [
      "CREATE INDEX IF NOT EXISTS audit_type ON audit (type)",
      "CREATE TABLE IF NOT EXISTS extra_notes (id TEXT PRIMARY KEY, body TEXT NOT NULL) STRICT",
      "INSERT OR IGNORE INTO migration_probe (n) VALUES (3)",
    ]
    : [
      "CREATE INDEX CONCURRENTLY IF NOT EXISTS audit_type ON audit (type)",
      'CREATE TABLE IF NOT EXISTS extra_notes (id text COLLATE "C" PRIMARY KEY, body text COLLATE "C" NOT NULL)',
      "INSERT INTO migration_probe (n) VALUES (3) ON CONFLICT DO NOTHING",
    ],
});

export function registry(dialect: Dialect, name: RegistryName): readonly Migration[] {
  const first = (dialect === "sqlite" ? SQLITE : POSTGRES).slice(0, 1);
  switch (name) {
    case "v1": return first;
    case "v12": return [...first, v2(dialect)];
    case "v123": return [...first, v2(dialect), v3(dialect)];
    case "v12-with-erasing-v3": {
      // A (broken) non-transactional migration whose statement deletes its own journal row: the runner must notice that it is not
      // getting anywhere instead of applying it again forever.
      return [...first, v2(dialect), { version: 3, name: "erases_its_own_journal_row", transactional: false, statements: ["DELETE FROM schema_migrations WHERE version = 3"] }];
    }
    case "v123-with-v2-edited": {
      const edited = { ...v2(dialect), statements: [...v2(dialect).statements, "SELECT 1"] };
      return [...first, edited, v3(dialect)];
    }
  }
}
