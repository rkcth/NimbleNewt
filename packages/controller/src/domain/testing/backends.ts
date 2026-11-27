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

/**
 * How long a domain suite's PostgreSQL storage waits for one new connection (TCP connect, startup and sign-in) to the embedded test server, in place of the product default of 5 s
 * (CI fix 6). The server is local and known to be running, so a connection that has not finished is a slow machine, not an absent server: on the hosted Windows runner every new
 * connection is a new postgres.exe process, started while two other test files run beside it, and once in 781 PostgreSQL tests (exhaustive run 46037162616, Node 24, shard 1) one
 * took more than 5 s and failed its test with "timeout expired" while the tests before and after took about a second. Lock and statement timeouts stay the product's; the tests that
 * check the connect timeout itself set their own (postgres.test.ts, no-answer.test.ts, standby.test.ts).
 */
export const TEST_CONNECT_TIMEOUT_MS = 30_000;

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
    const storage = await PostgresStorage.open({ connectionString: s.url(), schema, connectTimeoutMs: TEST_CONNECT_TIMEOUT_MS });
    return { storage, close: async () => { await storage.close(); await withClient(s.url(), async (c) => { await c.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`); }); } };
  } },
];

/**
 * The typical tier (card X11, `NIMBLENEWT_TIER=typical`) runs the domain suites on the reference store and SQLite; the exhaustive tier runs all four. The typical tier also leaves out the long
 * storage qualification runs (scripts/slow-tests.json), so PostgreSQL and the worker-thread variant are covered there only by their basic suites: a change to storage should be checked with the
 * exhaustive tier (`npm test`, or the Exhaustive tests workflow).
 */
export const backends: Backend[] = process.env["NIMBLENEWT_TIER"] === "typical" ? all.filter((b) => b.name === "reference store" || b.name === "SQLite") : all;

/**
 * The backend of this name as a list, for a suite divided among test files by backend (one file per backend, so that a long suite stays well within the per-file
 * time limit on a slow CI machine). Empty when the typical tier leaves that backend out; a name that is no backend at all is a mistake.
 */
/** Every backend's name, whatever the tier (backend-split.test.ts checks that each suite divided by backend has one file per name). */
export const backendNames: readonly string[] = all.map((b) => b.name);
export function backendsNamed(name: string): Backend[] {
  if (!all.some((b) => b.name === name)) throw new Error(`no backend named ${name}`);
  return backends.filter((b) => b.name === name);
}
