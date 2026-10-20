import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { test } from "node:test";
import { StorageError } from "../errors.js";
import { registry, type RegistryName } from "../qualification/migration-registry.js";
import {
  cannotLoopForever, concurrentOpensApplyOnce, refusals, resumesRunningMigrations, upgradeCrashMatrix, upgradePreservesState, type Description, type MigrationOutcome, type MigrationRig, type MigrationWorld,
} from "../qualification/migrations-suite.js";
import { SqliteStorage } from "./index.js";

const child = fileURLToPath(new URL("./testing/child.js", import.meta.url));
const guard = pathToFileURL(fileURLToPath(new URL("../../../../../scripts/offline-guard.mjs", import.meta.url))).href;

function runChild(path: string, name: RegistryName, point?: { when: string; ordinal: number }): Promise<MigrationOutcome & { stderr: string }> {
  return new Promise((resolve, reject) => {
    const proc = spawn(process.execPath, ["--import", guard, child, "migrate", path, point?.when ?? "none", point === undefined ? "none" : String(point.ordinal), name], { stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    let err = "";
    proc.stdout.on("data", (d: Buffer) => { out += d.toString(); });
    proc.stderr.on("data", (d: Buffer) => { err += d.toString(); });
    proc.on("error", reject);
    proc.on("exit", () => {
      const done = /completed (\d+)/.exec(out);
      // A refusal is reported by the child as an uncaught StorageError on stderr; surface its message.
      const refused = /StorageError: ([^\n]*)/.exec(err);
      resolve({ crashed: done === null && refused === null, statements: done === null ? 0 : Number(done[1]), stderr: err, ...(refused === null ? {} : { error: new StorageError("unavailable", refused[1]!) }) });
    });
  });
}

const rig: MigrationRig = {
  name: "sqlite",
  dialect: "sqlite",
  open: async () => {
    const dir = mkdtempSync(join(tmpdir(), "nn sqlite-migration-"));
    const path = join(dir, "controller.sqlite");
    const world: MigrationWorld = {
      attempt: async (migrations, point) => {
        if (point !== undefined) return runChild(path, migrations, point);
        let last = 0;
        try {
          const storage = await SqliteStorage.open({ path, migrations: registry("sqlite", migrations), testHooks: { statement: (_p, _s, ordinal) => { last = Math.max(last, ordinal); } } });
          await storage.close();
          return { crashed: false, statements: last };
        } catch (error) {
          if (error instanceof StorageError) return { crashed: false, statements: last, error };
          throw error;
        }
      },
      withStorage: async (migrations, fn) => {
        const storage = await SqliteStorage.open({ path, migrations: registry("sqlite", migrations) });
        try { return await fn(storage); } finally { await storage.close(); }
      },
      describe: async (): Promise<Description> => {
        const raw = new DatabaseSync(path);
        try {
          const tables = (name: string) => raw.prepare("SELECT count(*) AS n FROM sqlite_schema WHERE name = ?").get(name)!.n === 1;
          const structure = raw.prepare("SELECT type, name, tbl_name, sql FROM sqlite_schema WHERE name NOT LIKE 'sqlite_%' ORDER BY name").all().map((r) => ({ ...r }));
          return {
            structure,
            journal: tables("schema_migrations") ? raw.prepare("SELECT version, name, state FROM schema_migrations ORDER BY version").all().map((r) => ({ version: r.version as number, name: r.name as string, state: r.state as string })) : [],
            probe: tables("migration_probe") ? raw.prepare("SELECT n FROM migration_probe ORDER BY n").all().map((r) => r.n as number) : [],
          };
        } finally { raw.close(); }
      },
      sql: async (statement) => { const raw = new DatabaseSync(path); try { raw.exec(statement); } finally { raw.close(); } },
      attemptTwice: async (migrations) => {
        const both = await Promise.all([runChild(path, migrations), runChild(path, migrations)]);
        return both.map(({ crashed, statements, error }) => ({ crashed, statements, ...(error === undefined ? {} : { error }) }));
      },
      close: async () => { rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }); },
    };
    return world;
  },
};

test("SQLite: an upgrade preserves a populated database and the adapter keeps working on the new layout", () => upgradePreservesState(rig));
test("SQLite: a database from a newer version, an edited migration and a journal gap are refused and left untouched", () => refusals(rig));
test("SQLite: an interrupted non-transactional migration is finished by the next start; a running entry with different content is refused", () => resumesRunningMigrations(rig));
test("SQLite: two processes opening one database at once apply each migration exactly once", () => concurrentOpensApplyOnce(rig));
test("SQLite: an upgrade killed before or after every statement leaves a recoverable database, never half a migration, and recovery reaches the uninterrupted state", async (t) => {
  const report = await upgradeCrashMatrix(rig);
  t.diagnostic(`upgrade crash matrix: ${report.statements} statements, ${report.points} crash points`);
  assert.ok(report.points >= 30);
});

test("SQLite: a migration that cannot be journaled stops the runner with an error instead of repeating forever", { timeout: 90_000 }, () => cannotLoopForever(rig));
