import { StorageError } from "./errors.js";
import { canonicalJson, sha256 } from "./json.js";

/**
 * Schema migrations for the controller databases (card F04). Each backend has its own list of migrations in its own SQL dialect and
 * its own journal table; this module holds the part that is the same: what a migration is, how it is identified, and how the journal
 * recorded in a database is compared with the migrations this build knows to decide what to do.
 *
 * Rules:
 * - Migrations are numbered 1, 2, 3 ... without gaps. Migration 1 creates the whole first layout.
 * - An applied migration is never edited: its content is recorded as a checksum, and a database whose recorded checksum differs from
 *   this build's is refused. Changes are always a new migration.
 * - A database whose journal has a migration this build does not know (it was written by a newer NimbleNewt) is refused untouched:
 *   there are no downgrades.
 * - A migration is normally **transactional**: its statements and its journal entry commit together, so an interruption leaves the
 *   database exactly as it was and the next start simply runs it again. A migration that cannot run inside a transaction (for example
 *   building an index concurrently) sets `transactional: false`; it is journaled as `running` before its statements run, its
 *   statements **must be idempotent**, and after an interruption the next start finds it `running` and runs it again.
 */
export interface Migration {
  readonly version: number;
  /** A short stable name, recorded in the journal. */
  readonly name: string;
  /** The statements, one per entry, in this backend's SQL dialect. */
  readonly statements: readonly string[];
  /** Default true. See above for what false requires. */
  readonly transactional?: boolean;
  /**
   * `additive` (the default): the change only adds (a table, a nullable or defaulted column, an index), so the previous release's code still runs on the result. `destructive` (card K03): the change removes
   * or reshapes something the previous release reads (drop, rename, narrowing, a rewrite of data). A destructive migration is **deferred**: it does not run when a database is opened unless the opener
   * allows it (`contractThrough`), which the controller does only after the owner's approval once the rollback period has passed. Everything after a deferred migration waits too (numbering stays gapless).
   * A destructive migration is written so that the release that ships it already works with the old and the new layout (expand, then contract).
   */
  readonly kind?: "additive" | "destructive";
}

export type JournalState = "running" | "done";
export interface JournalEntry { readonly version: number; readonly name: string; readonly checksum: string; readonly state: JournalState }

/** The identity of a migration's content. */
export const migrationChecksum = (m: Migration): string => sha256(canonicalJson({ version: m.version, name: m.name, statements: m.statements, transactional: m.transactional !== false, ...(m.kind === "destructive" ? { kind: "destructive" } : {}) }));

/** Whether a migration is destructive (card K03). */
export const isDestructive = (m: Migration): boolean => m.kind === "destructive";

/** Checks a list of migrations for the mistakes a programmer can make; throws a plain Error (these are bugs, not runtime conditions). */
export function assertValidMigrations(migrations: readonly Migration[]): void {
  if (migrations.length === 0) throw new Error("a backend needs at least one migration");
  const names = new Set<string>();
  migrations.forEach((m, i) => {
    if (m.version !== i + 1) throw new Error(`migrations must be numbered 1, 2, 3 without gaps; position ${i + 1} is version ${m.version}`);
    if (!/^[a-z][a-z0-9_]{0,60}$/.test(m.name)) throw new Error(`migration ${m.version}: name "${m.name}" must be lower-case words joined by underscores`);
    if (names.has(m.name)) throw new Error(`migration ${m.version}: name "${m.name}" is used twice`);
    names.add(m.name);
    if (m.kind !== undefined && m.kind !== "additive" && m.kind !== "destructive") throw new Error(`migration ${m.version} (${m.name}): kind must be additive or destructive`);
    if (m.statements.length === 0 || m.statements.some((s) => s.trim() === "")) throw new Error(`migration ${m.version} (${m.name}) has an empty statement`);
  });
}

export interface MigrationPlan {
  /** The highest migration recorded as done (0 for a new database). */
  readonly applied: number;
  /** A migration journaled as `running` by an interrupted earlier start: run it again first. */
  readonly resume: Migration | undefined;
  /** Migrations still to apply now, in order (not including `resume`). */
  readonly pending: readonly Migration[];
  /** Migrations that are due but wait (card K03): the first destructive one the opener did not allow, and every migration after it. Absent when nothing waits. */
  readonly deferred?: readonly Migration[];
}

export interface PlanOptions {
  /** The highest destructive migration the opener allows to run (default 0: none). A destructive migration above it, and everything after it, is deferred. */
  readonly contractThrough?: number;
}

/**
 * How far an opener would bring a database that has applied `applied` migrations: the number of the last migration that would run now (card K03). Used by the pre-upgrade snapshot so a start that
 * only finds deferred work takes no snapshot. Pure.
 */
export function runnableThrough(migrations: readonly Migration[], applied: number, options: PlanOptions = {}): number {
  const allowed = options.contractThrough ?? 0;
  let through = applied;
  for (const m of migrations.slice(applied)) {
    if (isDestructive(m) && m.version > allowed) break;
    through = m.version;
  }
  return through;
}

const refuse = (message: string): never => { throw new StorageError("unavailable", message); };

/**
 * Compares the journal found in a database with the migrations of this build. Pure. Refuses (with an `unavailable` error and a
 * message saying what to do) a database that is newer than this build, whose journal has a gap or a second interrupted migration, or
 * in which an applied migration's name or content differs from this build's.
 */
export function planMigrations(migrations: readonly Migration[], journal: readonly JournalEntry[], options: PlanOptions = {}): MigrationPlan {
  assertValidMigrations(migrations);
  const latest = migrations.length;
  const entries = [...journal].sort((a, b) => a.version - b.version);
  entries.forEach((entry, i) => {
    if (entry.version > latest) {
      refuse(`the database has schema migration ${entry.version} (${entry.name}), newer than the latest this version of NimbleNewt knows (${latest}); upgrade NimbleNewt or restore a backup made by this version. Nothing was changed.`);
    }
    if (entry.version !== i + 1) refuse(`the schema journal is missing migration ${i + 1}; the database was modified by something other than NimbleNewt. Nothing was changed.`);
    const known = migrations[entry.version - 1]!;
    if (entry.name !== known.name || entry.checksum !== migrationChecksum(known)) {
      refuse(`schema migration ${entry.version} (${entry.name}) was changed after it was applied to this database (recorded ${entry.checksum.slice(0, 12)}, this version has ${migrationChecksum(known).slice(0, 12)}). Applied migrations are never edited. Nothing was changed.`);
    }
    if (entry.state === "running" && i !== entries.length - 1) refuse(`the schema journal shows migration ${entry.version} still running although later migrations were recorded. Nothing was changed.`);
  });
  const last = entries[entries.length - 1];
  const resume = last?.state === "running" ? migrations[last.version - 1] : undefined;
  const applied = last === undefined ? 0 : last.state === "done" ? last.version : last.version - 1;
  const due = migrations.slice(resume === undefined ? applied : applied + 1);
  const allowed = options.contractThrough ?? 0;
  const wait = due.findIndex((m) => isDestructive(m) && m.version > allowed);
  if (wait < 0) return { applied, resume, pending: due };
  return { applied, resume, pending: due.slice(0, wait), deferred: due.slice(wait) };
}
