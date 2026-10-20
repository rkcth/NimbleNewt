import assert from "node:assert/strict";
import { after, test } from "node:test";
import { OVERRIDE_FLAG } from "../../environment/index.js";
import { isStorageError } from "../errors.js";
import { PostgresStorage } from "./index.js";
import { startTestServer, withClient, type TestServer } from "./testing/server.js";

let serverPromise: Promise<TestServer> | undefined;
const server = (): Promise<TestServer> => (serverPromise ??= startTestServer());
after(async () => { if (serverPromise !== undefined) await (await serverPromise).stop(); });

async function withSchema<T>(body: (url: string, schema: string) => Promise<T>): Promise<T> {
  const s = await server();
  const schema = `env_${process.pid}_${Math.random().toString(36).slice(2, 8)}`;
  try { return await body(s.url(), schema); } finally { await withClient(s.url(), async (c) => { await c.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`); }); }
}

// The test server is PostgreSQL 17, which is supported, so an older minimum is simulated by raising the enforced minimum above it.
test("a server inside the supported range opens, with nothing to report", () => withSchema(async (url, schema) => {
  const storage = await PostgresStorage.open({ connectionString: url, schema });
  try { assert.equal(storage.unsupportedServer, undefined); } finally { await storage.close(); }
}));

test("a server below the supported minimum is refused with what was found, what is supported, how to test it and the override", () => withSchema(async (url, schema) => {
  await assert.rejects(PostgresStorage.open({ connectionString: url, schema, minimumServerVersionNum: 990000 }), (error: unknown) => {
    assert.ok(isStorageError(error, "unavailable"));
    assert.match(error.message, /will not start/);
    assert.match(error.message, /PostgreSQL: found 17\./);
    assert.match(error.message, /99 or newer|supported: 17 or newer/);
    assert.match(error.message, /scripts\/postgres-versions\.mjs 17/);
    assert.ok(error.message.includes(OVERRIDE_FLAG));
    return true;
  });
  await withClient(url, async (c) => { assert.equal((await c.query(`SELECT 1 FROM information_schema.schemata WHERE schema_name = $1`, [schema])).rowCount, 0, "nothing was created in the refused database"); });
}));

test("the enforced minimum cannot be lowered to skip the refusal", async () => {
  for (const lower of [0, 120000, 160000, 169999, 170000.5, Number.NaN]) {
    await assert.rejects(PostgresStorage.open({ connectionString: "postgres://localhost:1/none", minimumServerVersionNum: lower }), (error: unknown) => isStorageError(error, "invalid_input") && error.path === "minimumServerVersionNum", String(lower));
  }
});

test("with the override the same server starts, reports the problem for start-up to print and audit, and behaves exactly as before", () => withSchema(async (url, schema) => {
  const storage = await PostgresStorage.open({ connectionString: url, schema, minimumServerVersionNum: 990000, allowUnsupportedServer: true });
  try {
    assert.equal(storage.unsupportedServer?.item, "PostgreSQL");
    assert.match(storage.unsupportedServer?.found ?? "", /^17\./);
    const { epoch } = await storage.acquireEpoch({ holder: "c1", at: "2026-10-20T10:00:00.000Z" });
    const result = await storage.applyOperation({
      operationId: "op-1", epoch, actor: "t", correlationId: "c", at: "2026-10-20T10:00:00.000Z",
      changes: [{ type: "create", ref: { kind: "thing", id: "a" }, body: { x: 1 } }], audit: [], outbox: [], effects: [], timers: [], cancelTimers: [], completeDeliveries: [], completeTimers: [], settleEffects: [],
    });
    assert.deepEqual(result.revisions.map((r) => r.revision), [1]);
    assert.deepEqual((await storage.getAggregate({ kind: "thing", id: "a" }))?.body, { x: 1 });
  } finally { await storage.close(); }
}));
