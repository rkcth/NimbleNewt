import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MemoryStorage } from "../../storage/memory.js";
import { PostgresStorage } from "../../storage/postgres/index.js";
import { startTestServer, withClient, type TestServer } from "../../storage/postgres/testing/server.js";
import { SqliteStorage, SqliteWorkerStorage } from "../../storage/sqlite/index.js";
import type { ControllerStorage } from "../../storage/types.js";

/** The storage implementations every domain service is tested against: the same tests, each of the four. */
export interface World { readonly storage: ControllerStorage; close(): Promise<void> }
export interface Backend { readonly name: string; open(): Promise<World> }

let serverPromise: Promise<TestServer> | undefined;
const server = (): Promise<TestServer> => (serverPromise ??= startTestServer());
/** Call from the test file's `after`: stops the PostgreSQL server if any test started it. */
export async function stopServer(): Promise<void> {
  if (serverPromise !== undefined) await (await serverPromise).stop();
}

const sqliteDir = () => mkdtempSync(join(tmpdir(), "nn-domain-"));
const remove = (dir: string) => rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });

const all: Backend[] = [
  { name: "reference store", open: async () => { const storage = new MemoryStorage(); return { storage, close: () => storage.close() }; } },
  { name: "SQLite", open: async () => {
    const dir = sqliteDir();
    const storage = await SqliteStorage.open({ path: join(dir, "c.sqlite") });
    return { storage, close: async () => { await storage.close(); remove(dir); } };
  } },
  { name: "SQLite on a worker thread", open: async () => {
    const dir = sqliteDir();
    const storage = await SqliteWorkerStorage.open({ path: join(dir, "c.sqlite") });
    return { storage, close: async () => { await storage.close(); remove(dir); } };
  } },
  { name: "PostgreSQL", open: async () => {
    const s = await server();
    const schema = `domain_${process.pid}_${Math.random().toString(36).slice(2, 8)}`;
    const storage = await PostgresStorage.open({ connectionString: s.url(), schema });
    return { storage, close: async () => { await storage.close(); await withClient(s.url(), async (c) => { await c.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`); }); } };
  } },
];

/**
 * The typical tier (card X11, `NIMBLENEWT_TIER=typical`) runs the domain suites on the reference store and SQLite; the exhaustive tier runs all four. The typical tier also leaves out the long
 * storage qualification runs (scripts/slow-tests.json), so PostgreSQL and the worker-thread variant are covered there only by their basic suites: a change to storage should be checked with the
 * exhaustive tier (`npm test`, or the Exhaustive tests workflow).
 */
export const backends: Backend[] = process.env["NIMBLENEWT_TIER"] === "typical" ? all.filter((b) => b.name === "reference store" || b.name === "SQLite") : all;
