import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { MemoryStorage } from "./memory.js";
import { PostgresStorage } from "./postgres/index.js";
import { startTestServer, withClient, type TestServer } from "./postgres/testing/server.js";
import { assertInvariants, runWorkload, type WorkloadSpec } from "./qualification/workload.js";
import { SqliteStorage } from "./sqlite/index.js";

let serverPromise: Promise<TestServer> | undefined;
const server = (): Promise<TestServer> => (serverPromise ??= startTestServer());
after(async () => { if (serverPromise !== undefined) await (await serverPromise).stop(); });

// A short run: it checks that nothing is lost or duplicated under concurrent load, not how fast anything is.
const SMOKE: WorkloadSpec = { name: "smoke", agents: 6, idleHosts: 10, hostPeriodMs: 100, inquirers: 1, hotRow: false, thinkMs: 2, durationMs: 1500, warmupMs: 200 };
const HOT: WorkloadSpec = { ...SMOKE, name: "smoke, hot row", hotRow: true };

for (const spec of [SMOKE, HOT]) {
  test(`reference store: nothing is lost or duplicated under concurrent load (${spec.name})`, async () => {
    const storage = new MemoryStorage();
    try { assertInvariants(await runWorkload(storage, spec)); } finally { await storage.close(); }
  });

  test(`SQLite: nothing is lost or duplicated under concurrent load (${spec.name})`, async () => {
    const dir = mkdtempSync(join(tmpdir(), "nn-workload-"));
    const storage = await SqliteStorage.open({ path: join(dir, "controller.sqlite") });
    try {
      const result = await runWorkload(storage, spec);
      assertInvariants(result);
      assert.ok(result.latency.transition!.count > 3, "almost no work was done: the load did not run"); // slow disks (Windows runners) complete few commits in 1.5 s; the invariants are the point
      assert.ok(result.latency.inquiry!.count > 0 && result.latency.heartbeat!.count > 0);
    } finally { await storage.close(); rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }); }
  });

  test(`PostgreSQL: nothing is lost or duplicated under concurrent load (${spec.name})`, async () => {
    const s = await server();
    const schema = `wl_${process.pid}_${spec.hotRow ? "hot" : "plain"}`;
    const storage = await PostgresStorage.open({ connectionString: s.url(), schema, maxConnections: 8 });
    try {
      const result = await runWorkload(storage, spec, { poolStats: () => storage.poolStats() });
      assertInvariants(result);
      assert.ok(result.latency.transition!.count > 3, "almost no work was done: the load did not run"); // slow disks (Windows runners) complete few commits in 1.5 s; the invariants are the point
      assert.ok(result.pool !== undefined && result.pool.maxTotal <= 8, "the pool grew beyond its bound");
      if (spec.hotRow) assert.ok(result.conflictsRetriedByCaller > 0, "a single shared row updated by every agent must produce conflicts, or the scenario is not testing contention");
    } finally { await storage.close(); await withClient(s.url(), async (c) => { await c.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`); }); }
  });
}
