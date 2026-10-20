import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { MemoryStorage } from "./memory.js";
import { PostgresStorage } from "./postgres/index.js";
import { startTestServer, withClient, type TestServer } from "./postgres/testing/server.js";
import { runParity } from "./qualification/parity.js";
import { SqliteStorage } from "./sqlite/index.js";

let serverPromise: Promise<TestServer> | undefined;
const server = (): Promise<TestServer> => (serverPromise ??= startTestServer());
after(async () => { if (serverPromise !== undefined) await (await serverPromise).stop(); });

const SEEDS = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12];
const STEPS = 500;

for (const seed of SEEDS) {
  test(`the reference store, SQLite and PostgreSQL agree on every result and on the final state (seed ${seed}, ${STEPS} steps)`, { timeout: 180_000 }, async (t) => {
    const dir = mkdtempSync(join(tmpdir(), "nn-parity-"));
    const s = await server();
    const schema = `parity_${process.pid}_${seed}`;
    const memory = new MemoryStorage();
    const sqlite = await SqliteStorage.open({ path: join(dir, "controller.sqlite") });
    const postgres = await PostgresStorage.open({ connectionString: s.url(), schema });
    try {
      const report = await runParity(seed, STEPS, [{ name: "memory", storage: memory }, { name: "sqlite", storage: sqlite }, { name: "postgres", storage: postgres }]);
      t.diagnostic(`seed ${seed}: ${report.successes} successful calls; refusals ${JSON.stringify(report.refusals)}`);
      assert.ok(report.successes > STEPS * 0.25, `too few successful calls (${report.successes}) to be a meaningful comparison`);
      assert.ok(Object.keys(report.refusals).length >= 5, `too few kinds of refusal exercised: ${Object.keys(report.refusals).join()}`);
    } finally {
      await memory.close(); await sqlite.close(); await postgres.close();
      rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
      await withClient(s.url(), async (c) => { await c.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`); });
    }
  });
}
