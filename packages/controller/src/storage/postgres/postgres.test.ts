import assert from "node:assert/strict";
import { after } from "node:test";
import { test } from "node:test";
import { setTimeout as sleep } from "node:timers/promises";
import pg from "pg";
import { commitOperation, isStorageError, runStorageConformance, type OperationInput } from "../index.js";
import { classify, isConnectionLoss } from "./errors.js";
import { PostgresStorage, SCHEMA_VERSION } from "./index.js";
import { FaultProxy } from "./testing/proxy.js";
import { startEmbeddedServer, startTestServer, withClient, type TestServer } from "./testing/server.js";

const T0 = "2026-10-19T12:00:00.000Z";
/** The simple-query message "COMMIT": type byte Q, a 4-byte length, the text and a NUL (BEGIN ... READ COMMITTED must not match). */
const COMMIT_MESSAGE = /^Q[\s\S]{4}COMMIT\0/;
const op = (operationId: string, over: Partial<OperationInput> = {}): OperationInput => ({
  operationId, epoch: 1, actor: "test", correlationId: `c-${operationId}`, at: T0, changes: [], audit: [], outbox: [], effects: [], timers: [], cancelTimers: [],
  completeDeliveries: [], completeTimers: [], settleEffects: [], ...over,
});
const create = (kind: string, id: string, body: Record<string, number | string> = {}) => ({ type: "create" as const, ref: { kind, id }, body });
const update = (kind: string, id: string, expectedRevision: number, body: Record<string, number | string> = {}) => ({ type: "update" as const, ref: { kind, id }, expectedRevision, body });

let serverPromise: Promise<TestServer> | undefined;
const server = (): Promise<TestServer> => (serverPromise ??= startTestServer());
after(async () => { if (serverPromise !== undefined) await (await serverPromise).stop(); });

let counter = 0;
const schemaName = (): string => `t_${process.pid}_${counter++}_${Math.random().toString(36).slice(2, 8)}`;
async function dropSchema(url: string, schema: string): Promise<void> {
  await withClient(url, async (c) => { await c.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`); });
}

/** Opens a store in a fresh schema; `close` drops the schema. */
async function fresh(options: Partial<Parameters<typeof PostgresStorage.open>[0]> = {}, url?: string) {
  const s = await server();
  const schema = schemaName();
  const connectionString = url ?? s.url();
  const storage = await PostgresStorage.open({ connectionString, schema, ...options });
  return { storage, schema, url: s.url(), close: async () => { await storage.close(); await dropSchema(s.url(), schema); } };
}

// ---- the shared semantic fixtures, against a real PostgreSQL server ---------------------------------------------
runStorageConformance({
  name: "PostgresStorage",
  open: async () => {
    const { storage, close } = await fresh();
    return { storage, close };
  },
});

// ---- settings, schema, connection problems ------------------------------------------------------------------------
test("the server and session settings are verified and read back", async () => {
  const { storage, schema, close } = await fresh({ maxConnections: 7, lockTimeoutMs: 1234, statementTimeoutMs: 5678 });
  try {
    const s = await storage.settings();
    assert.deepEqual({ ...s, serverVersion: "x", serverVersionNum: 0 }, {
      serverVersion: "x", serverVersionNum: 0, schema, schemaVersion: SCHEMA_VERSION, synchronousCommit: "on", fsync: "on", fullPageWrites: "on", isolation: "read committed",
      maxConnections: 7, lockTimeoutMs: 1234, statementTimeoutMs: 5678,
    });
    assert.ok(s.serverVersionNum >= 140000);
    const live = await withClient((await server()).url(), async () => undefined);
    void live;
  } finally { await close(); }
});

test("a reopened database keeps everything that was committed, and a second store sees the same state", async () => {
  const { storage, schema, url, close } = await fresh();
  try {
    await storage.acquireEpoch({ holder: "a", at: T0 });
    const command = op("o1", { changes: [create("task", "t1", { a: 1 })], audit: [{ type: "x", detail: {} }] });
    await storage.applyOperation(command);
    const other = await PostgresStorage.open({ connectionString: url, schema });
    assert.equal(await other.currentEpoch(), 1);
    assert.equal((await other.getAggregate({ kind: "task", id: "t1" }))?.revision, 1);
    assert.equal((await other.applyOperation(command)).replayed, true);
    await other.close();
  } finally { await close(); }
});

test("refuses a newer schema, a schema of foreign tables, and bad options, without changing anything", async () => {
  const s = await server();
  const { storage, schema, close } = await fresh();
  try {
    await storage.close();
    await withClient(s.url(), async (c) => { await c.query(`UPDATE ${schema}.schema_info SET version = ${SCHEMA_VERSION + 1}`); });
    await assert.rejects(PostgresStorage.open({ connectionString: s.url(), schema }), (e) => isStorageError(e, "unavailable") && /newer than this version/.test((e as Error).message));
    await withClient(s.url(), async (c) => { await c.query(`UPDATE ${schema}.schema_info SET version = 0`); });
    await assert.rejects(PostgresStorage.open({ connectionString: s.url(), schema }), (e) => isStorageError(e, "unavailable") && /needs a migration/.test((e as Error).message));

    const foreign = schemaName();
    await withClient(s.url(), async (c) => { await c.query(`CREATE SCHEMA ${foreign}; CREATE TABLE ${foreign}.something_else (x int)`); });
    await assert.rejects(PostgresStorage.open({ connectionString: s.url(), schema: foreign }), (e) => isStorageError(e, "unavailable") && /did not create/.test((e as Error).message));
    const tables = await withClient(s.url(), async (c) => (await c.query("SELECT table_name FROM information_schema.tables WHERE table_schema = $1", [foreign])).rows.map((r) => r.table_name));
    assert.deepEqual(tables, ["something_else"]);
    await dropSchema(s.url(), foreign);

    for (const [options, path] of [[{ schema: "Bad-Name" }, "schema"], [{ maxConnections: 0 }, "maxConnections"], [{ connectTimeoutMs: -5 }, "connectTimeoutMs"], [{ connectionString: "mysql://x" }, "connectionString"]] as const) {
      await assert.rejects(PostgresStorage.open({ connectionString: s.url(), ...options }), (e) => isStorageError(e, "invalid_input") && (e as { path?: string }).path === path, path);
    }
  } finally { await dropSchema(s.url(), schema); }
});

test("an unreachable server, a wrong password and a missing database fail fast as unavailable", async () => {
  const s = await server();
  if (s.kind !== "embedded") return; // the URL parts are only known for the embedded server
  const url = new URL(s.url());
  const started = Date.now();
  const closedPort = await new Promise<number>((resolve) => { const probe = (await_net()).createServer(); probe.listen(0, "127.0.0.1", () => { const p = (probe.address() as { port: number }).port; probe.close(() => resolve(p)); }); });
  await assert.rejects(PostgresStorage.open({ connectionString: `postgres://nn:x@127.0.0.1:${closedPort}/db`, schema: schemaName() }), (e) => isStorageError(e, "unavailable") && /cannot reach/.test((e as Error).message));
  assert.ok(Date.now() - started < 4000, "an unreachable server must not hang");
  const wrong = new URL(url); wrong.password = "definitely-wrong";
  await assert.rejects(PostgresStorage.open({ connectionString: wrong.toString(), schema: schemaName() }), (e) => isStorageError(e, "unavailable"));
  const missing = new URL(url); missing.pathname = "/no_such_database";
  await assert.rejects(PostgresStorage.open({ connectionString: missing.toString(), schema: schemaName() }), (e) => isStorageError(e, "unavailable"));
});
function await_net(): typeof import("node:net") { return process.getBuiltinModule("node:net") as typeof import("node:net"); }

test("a server configured without durable writes is refused", async () => {
  const unsafe = await startEmbeddedServer(["-c", "fsync=off"]);
  try {
    await assert.rejects(PostgresStorage.open({ connectionString: unsafe.url(), schema: schemaName() }), (e) => isStorageError(e, "unavailable") && /without durable writes \(fsync=off/.test((e as Error).message));
    const leftovers = await withClient(unsafe.url(), async (c) => (await c.query("SELECT count(*)::int AS n FROM pg_namespace WHERE nspname LIKE 't\\_%'")).rows[0]!.n);
    assert.equal(leftovers, 0, "nothing may be created on a server that was refused");
  } finally { await unsafe.stop(); }
});

// ---- failure classification --------------------------------------------------------------------------------------
test("driver errors are classified, never leaked", () => {
  const withCode = (code: string, message = "boom") => Object.assign(new Error(message), { code });
  const kinds = (error: unknown, phase: "work" | "commit" = "work", unknown: "uncertain_commit" | "retryable" = "uncertain_commit") => classify(error, phase, unknown).kind;
  for (const code of ["40P01", "40001", "55P03", "57014", "53300"]) assert.equal(kinds(withCode(code)), "retryable", code);
  for (const code of ["23505", "23503", "23514", "23502"]) { assert.equal(kinds(withCode(code)), "unavailable", code); assert.match(classify(withCode(code)).message, /invariant violation/); }
  for (const code of ["28P01", "3D000", "42P01", "53100", "25006", "XX000", "42501"]) assert.equal(kinds(withCode(code)), "unavailable", code);
  assert.match(classify(withCode("42501", "permission denied for database")).message, /needs CREATE on the database/);
  assert.equal(kinds(withCode("ECONNREFUSED")), "unavailable");
  assert.equal(kinds(new Error("timeout exceeded when trying to connect")), "retryable");
  // a lost connection: before COMMIT the transaction never committed; during COMMIT the outcome is unknown
  for (const lost of [withCode("ECONNRESET"), withCode("57P01"), withCode("08006"), new Error("Connection terminated unexpectedly"), new Error("Client has encountered a connection error and is not queryable")]) {
    assert.ok(isConnectionLoss(lost), String(lost));
    assert.equal(kinds(lost, "work"), "retryable");
    assert.equal(kinds(lost, "commit"), "uncertain_commit");
    assert.equal(kinds(lost, "commit", "retryable"), "retryable");
  }
  // a server error while committing is a definite rollback, not an unknown outcome
  assert.equal(kinds(withCode("40001"), "commit"), "retryable");
  assert.equal(kinds(withCode("23505"), "commit"), "unavailable");
  assert.ok(!isConnectionLoss(withCode("23505", "connection terminated")));
});

// ---- ambiguous commits, with the connection cut at exact statements -------------------------------------------------
async function throughProxy(options: Partial<Parameters<typeof PostgresStorage.open>[0]> = {}) {
  const s = await server();
  if (s.kind !== "embedded") return undefined;
  const real = new URL(s.url());
  const proxy = await FaultProxy.start({ host: "127.0.0.1", port: Number(real.port) });
  const viaProxy = new URL(real); viaProxy.port = String(proxy.port);
  const schema = schemaName();
  const storage = await PostgresStorage.open({ connectionString: viaProxy.toString(), schema, ...options });
  const direct = await PostgresStorage.open({ connectionString: s.url(), schema });
  await direct.acquireEpoch({ holder: "a", at: T0 });
  return { storage, direct, proxy, schema, close: async () => { await storage.close(); await direct.close(); await proxy.stop(); await dropSchema(s.url(), schema); } };
}

test("a commit that succeeded but whose answer was lost is resolved by operation ID, and admitted once", async () => {
  const rig = await throughProxy();
  if (rig === undefined) return;
  try {
    const command = op("lost-answer", { changes: [create("task", "t1")], audit: [{ type: "x", detail: {} }], outbox: [{ deliveryId: "d1", destination: "d", priority: 5, aggregate: { kind: "task", id: "t1" }, payload: {} }] });
    rig.proxy.inject({ match: COMMIT_MESSAGE, when: "after" });
    await assert.rejects(rig.storage.applyOperation(command), (e) => isStorageError(e, "uncertain_commit"), "the raw primitive must say the outcome is unknown");
    assert.equal(rig.proxy.fired, 1);
    assert.equal((await rig.direct.getOperation("lost-answer")) !== undefined, true, "the transaction did commit");

    const again = op("lost-answer-2", { changes: [create("task", "t2")], audit: [{ type: "x", detail: {} }] });
    rig.proxy.inject({ match: COMMIT_MESSAGE, when: "after" });
    const result = await commitOperation(rig.storage, again);
    assert.equal(result.replayed, true, "the helper resolved the ambiguity by asking for the operation");
    assert.equal((await rig.direct.listAudit({ afterSeq: 0, limit: 10 })).length, 2, "each operation was admitted exactly once");
    assert.equal((await rig.direct.getAggregate({ kind: "task", id: "t2" }))?.revision, 1);
  } finally { await rig.close(); }
});

test("a connection cut before COMMIT leaves nothing behind, and the helper resubmits", async () => {
  const rig = await throughProxy();
  if (rig === undefined) return;
  try {
    const command = op("never-arrived", { changes: [create("task", "t1")], audit: [{ type: "x", detail: {} }] });
    rig.proxy.inject({ match: COMMIT_MESSAGE, when: "before" });
    await assert.rejects(rig.storage.applyOperation(command), (e) => isStorageError(e, "uncertain_commit"));
    assert.equal(await rig.direct.getOperation("never-arrived"), undefined, "the server never saw the commit");
    rig.proxy.inject({ match: COMMIT_MESSAGE, when: "before" });
    const result = await commitOperation(rig.storage, command);
    assert.equal(result.replayed, false);
    assert.equal((await rig.direct.listAudit({ afterSeq: 0, limit: 10 })).length, 1);
  } finally { await rig.close(); }
});

test("a connection cut in the middle of a transaction rolls it back and is retryable", async () => {
  const rig = await throughProxy();
  if (rig === undefined) return;
  try {
    const command = op("mid", { changes: [create("task", "t1")], audit: [{ type: "x", detail: {} }], outbox: [{ deliveryId: "d1", destination: "d", priority: 5, aggregate: { kind: "task", id: "t1" }, payload: {} }] });
    for (const when of ["before", "after"] as const) {
      rig.proxy.inject({ match: /INSERT INTO audit/, when });
      await assert.rejects(rig.storage.applyOperation(command), (e) => isStorageError(e, "retryable"), when);
      assert.equal(await rig.direct.getOperation("mid"), undefined, `${when}: a half-finished transaction survived`);
      assert.equal(await rig.direct.getAggregate({ kind: "task", id: "t1" }), undefined, when);
      assert.equal(await rig.direct.getDelivery("d1"), undefined, when);
    }
    assert.equal((await commitOperation(rig.storage, command)).replayed, false);
    assert.equal((await rig.direct.getAggregate({ kind: "task", id: "t1" }))?.revision, 1);
    // the pool replaced the broken connections: ordinary work continues
    await rig.storage.applyOperation(op("after", { audit: [{ type: "y", detail: {} }] }));
  } finally { await rig.close(); }
});

test("a claim whose answer was lost is safe to repeat once its lease ends", async () => {
  const rig = await throughProxy();
  if (rig === undefined) return;
  try {
    await rig.direct.applyOperation(op("seed", { changes: [create("task", "t1")], outbox: [{ deliveryId: "d1", destination: "d", priority: 5, aggregate: { kind: "task", id: "t1" }, payload: {} }] }));
    rig.proxy.inject({ match: COMMIT_MESSAGE, when: "after" });
    await assert.rejects(rig.storage.claimDeliveries({ epoch: 1, destination: "d", claimant: "w", now: T0, leaseMs: 1000, limit: 5 }), (e) => isStorageError(e, "retryable"));
    assert.equal((await rig.direct.getDelivery("d1"))?.state, "claimed", "the claim did happen");
    assert.deepEqual(await rig.direct.claimDeliveries({ epoch: 1, destination: "d", claimant: "w2", now: "2026-10-19T12:00:00.500Z", leaseMs: 1000, limit: 5 }), [], "still leased");
    const [again] = await rig.direct.claimDeliveries({ epoch: 1, destination: "d", claimant: "w2", now: "2026-10-19T12:00:01.000Z", leaseMs: 1000, limit: 5 });
    assert.equal(again?.attempt, 2);
  } finally { await rig.close(); }
});

// ---- bounded pool, bounded waits ---------------------------------------------------------------------------------
test("waiting on a row lock is bounded and retryable, and leaves nothing behind", async () => {
  const { storage, schema, url, close } = await fresh({ lockTimeoutMs: 300 });
  const blocker = new pg.Client({ connectionString: url });
  try {
    await storage.acquireEpoch({ holder: "a", at: T0 });
    await storage.applyOperation(op("seed", { changes: [create("task", "t1")] }));
    await blocker.connect();
    await blocker.query(`SET search_path = ${schema}`);
    await blocker.query("BEGIN");
    await blocker.query("SELECT * FROM aggregates WHERE kind = 'task' AND id = 't1' FOR UPDATE");
    const started = Date.now();
    await assert.rejects(storage.applyOperation(op("blocked", { changes: [update("task", "t1", 1, { n: 1 })], audit: [{ type: "x", detail: {} }] })), (e) => isStorageError(e, "retryable") && /lock/.test((e as Error).message));
    const waited = Date.now() - started;
    assert.ok(waited >= 250 && waited < 5000, `waited ${waited} ms for a 300 ms bound`);
    assert.equal(await storage.getOperation("blocked"), undefined);
    assert.equal((await storage.getAggregate({ kind: "task", id: "t1" }))?.revision, 1, "readers are not blocked by a writer's lock");
    await blocker.query("ROLLBACK");
    assert.equal((await commitOperation(storage, op("blocked", { changes: [update("task", "t1", 1, { n: 1 })], audit: [{ type: "x", detail: {} }] }))).replayed, false);
  } finally { await blocker.end().catch(() => undefined); await close(); }
});

test("the pool is bounded: with every connection busy, a new call fails as retryable after the connect timeout", async () => {
  const { storage, schema, url, close } = await fresh({ maxConnections: 1, connectTimeoutMs: 300, lockTimeoutMs: 3000 });
  const blocker = new pg.Client({ connectionString: url });
  try {
    await storage.acquireEpoch({ holder: "a", at: T0 });
    await storage.applyOperation(op("seed", { changes: [create("task", "t1")] }));
    await blocker.connect();
    await blocker.query(`SET search_path = ${schema}`);
    await blocker.query("BEGIN");
    await blocker.query("SELECT * FROM aggregates WHERE kind = 'task' AND id = 't1' FOR UPDATE");
    const slow = storage.applyOperation(op("holds-the-only-connection", { changes: [update("task", "t1", 1, { n: 1 })] })).then(() => "ok", (e: unknown) => (isStorageError(e) ? e.kind : "other"));
    await sleep(100);
    const started = Date.now();
    await assert.rejects(storage.getAggregate({ kind: "task", id: "t1" }), (e) => isStorageError(e, "retryable") && /connection/.test((e as Error).message));
    assert.ok(Date.now() - started < 2000);
    await blocker.query("ROLLBACK");
    assert.equal(await slow, "ok", "the waiting writer proceeds once the lock is released");
  } finally { await blocker.end().catch(() => undefined); await close(); }
});

// ---- concurrency: fencing, lock order, deadlock, claims, sequence numbers -----------------------------------------
test("a takeover waits for a writer that already passed the fence, and everything after it sees the new epoch", async () => {
  const { storage, schema, url, close } = await fresh({ lockTimeoutMs: 20_000 });
  const blocker = new pg.Client({ connectionString: url });
  try {
    await storage.acquireEpoch({ holder: "old", at: T0 });
    await storage.applyOperation(op("seed", { changes: [create("task", "t1")] }));
    await blocker.connect();
    await blocker.query(`SET search_path = ${schema}`);
    await blocker.query("BEGIN");
    await blocker.query("SELECT * FROM aggregates WHERE kind = 'task' AND id = 't1' FOR UPDATE");
    // The old primary's write passes the fence, then waits on the row the blocker holds.
    const inFlight = storage.applyOperation(op("in-flight", { changes: [update("task", "t1", 1, { n: 1 })] })).then(() => "ok", (e: unknown) => (isStorageError(e) ? e.kind : "other"));
    await sleep(200);
    const takeover = storage.acquireEpoch({ holder: "new", at: T0, expectedEpoch: 1 }).then((r) => r.epoch);
    assert.equal(await Promise.race([takeover, sleep(500).then(() => "still waiting")]), "still waiting", "the takeover must wait for the in-flight writer");
    await blocker.query("ROLLBACK");
    assert.equal(await inFlight, "ok", "a writer that passed the fence completes under the epoch it held");
    assert.equal(await takeover, 2);
    await assert.rejects(storage.applyOperation(op("late", { epoch: 1, audit: [{ type: "x", detail: {} }] })), (e) => isStorageError(e, "stale_epoch"));
    assert.equal(await storage.getOperation("late"), undefined);
  } finally { await blocker.end().catch(() => undefined); await close(); }
});

test("operations that touch the same aggregates in opposite order do not deadlock each other", async () => {
  const { storage, close } = await fresh({ maxConnections: 10 });
  try {
    await storage.acquireEpoch({ holder: "a", at: T0 });
    await storage.applyOperation(op("seed", { changes: [create("task", "a"), create("task", "b"), create("task", "c")] }));
    const outcomes: string[] = [];
    for (let round = 0; round < 15; round++) {
      const revision = round + 1;
      const forward = op(`f${round}`, { changes: [update("task", "a", revision, { r: round }), update("task", "b", revision, { r: round }), update("task", "c", revision, { r: round })], audit: [{ type: "x", detail: {} }] });
      const backward = op(`b${round}`, { changes: [update("task", "c", revision, { r: round }), update("task", "b", revision, { r: round }), update("task", "a", revision, { r: round })], audit: [{ type: "x", detail: {} }] });
      const settled = await Promise.all([forward, backward, forward, backward].map((o) => storage.applyOperation(o).then(() => "ok", (e: unknown) => (isStorageError(e) ? e.kind : String(e)))));
      outcomes.push(...settled);
      // exactly one of the distinct operations wins each round; the repeats of it replay
      assert.equal(settled.filter((k) => k === "revision_conflict").length, 2, settled.join());
    }
    assert.ok(outcomes.every((k) => k === "ok" || k === "revision_conflict"), `a deadlock or retryable error appeared: ${[...new Set(outcomes)].join()}`);
  } finally { await close(); }
});

test("operations that complete and cancel each other's timers, or insert the same IDs in opposite orders, never deadlock", async () => {
  const { storage, close } = await fresh({ maxConnections: 10, lockTimeoutMs: 20_000 });
  try {
    await storage.acquireEpoch({ holder: "a", at: T0 });
    const outcomes: string[] = [];
    const settle = (o: OperationInput) => storage.applyOperation(o).then(() => "ok", (e: unknown) => (isStorageError(e) ? e.kind : String(e)));
    const started = Date.now();
    for (let round = 0; round < 12; round++) {
      const [t0, t1] = [`ta${round}`, `tb${round}`];
      await storage.applyOperation(op(`mk${round}`, { timers: [{ timerId: t0, dueAt: T0, payload: {} }, { timerId: t1, dueAt: T0, payload: {} }] }));
      const claims = await storage.claimDueTimers({ epoch: 1, claimant: "w", now: "2026-10-19T13:00:00.000Z", leaseMs: 3_600_000, limit: 100 });
      const token = (id: string) => claims.find((c) => c.timerId === id)!.claimToken;
      // X completes t1 and cancels t0; Y completes t0 and cancels t1: opposite lock orders unless locking is unified and sorted.
      const crossed = await Promise.all([
        settle(op(`x${round}`, { completeTimers: [{ timerId: t1, claimToken: token(t1) }], cancelTimers: [t0] })),
        settle(op(`y${round}`, { completeTimers: [{ timerId: t0, claimToken: token(t0) }], cancelTimers: [t1] })),
      ]);
      outcomes.push(...crossed);
      // Two operations create the same pair of IDs, one in each order, one kind of ID at a time (a collision on an earlier kind
      // would otherwise serialise them before the later kind is reached): exactly one wins, neither deadlocks.
      for (const kind of ["effects", "timers", "outbox"] as const) {
        const mk = (id: string, order: string[]) => op(id, {
          changes: [create("task", `k${id}`)],
          ...(kind === "effects" ? { effects: order.map((e) => ({ effectId: `${e}${round}`, target: "x", inputDigest: "0".repeat(64) })) } : {}),
          ...(kind === "timers" ? { timers: order.map((e) => ({ timerId: `n${e}${round}`, dueAt: T0, payload: {} })) } : {}),
          ...(kind === "outbox" ? { outbox: order.map((e) => ({ deliveryId: `${e}${round}`, destination: "d", priority: 5, aggregate: { kind: "task", id: `k${id}` }, payload: {} })) } : {}),
        });
        outcomes.push(...(await Promise.all([settle(mk(`${kind}-p${round}`, ["a", "b"])), settle(mk(`${kind}-q${round}`, ["b", "a"]))])));
      }
    }
    const kinds = [...new Set(outcomes)].sort();
    assert.ok(outcomes.every((k) => k === "ok" || k === "state_conflict" || k === "duplicate_id"), `unexpected outcomes (retryable here means a deadlock was detected): ${kinds.join()}`);
    assert.ok(Date.now() - started < 15_000, "a detected deadlock costs deadlock_timeout (1 s) each; none may occur");
  } finally { await close(); }
});

test("a real deadlock between outside sessions is reported by the server and classified as retryable", async () => {
  const { storage, schema, url, close } = await fresh();
  const a = new pg.Client({ connectionString: url });
  const b = new pg.Client({ connectionString: url });
  try {
    await storage.acquireEpoch({ holder: "x", at: T0 });
    await storage.applyOperation(op("seed", { changes: [create("task", "one"), create("task", "two")] }));
    await a.connect(); await b.connect();
    for (const c of [a, b]) { await c.query(`SET search_path = ${schema}`); await c.query("BEGIN"); }
    await a.query("SELECT * FROM aggregates WHERE id = 'one' FOR UPDATE");
    await b.query("SELECT * FROM aggregates WHERE id = 'two' FOR UPDATE");
    const first = a.query("SELECT * FROM aggregates WHERE id = 'two' FOR UPDATE").then(() => undefined, (e: unknown) => e);
    await sleep(100);
    const second = b.query("SELECT * FROM aggregates WHERE id = 'one' FOR UPDATE").then(() => undefined, (e: unknown) => e);
    const errors = (await Promise.all([first, second])).filter((e) => e !== undefined);
    assert.equal(errors.length, 1, "the server must break the deadlock by aborting exactly one session");
    assert.equal((errors[0] as { code?: string }).code, "40P01");
    assert.equal(classify(errors[0]).kind, "retryable");
  } finally { await a.end().catch(() => undefined); await b.end().catch(() => undefined); await close(); }
});

test("competing claimants on a real server never receive the same delivery, and the ordering chain yields only its head", async () => {
  const { storage, close } = await fresh({ maxConnections: 10 });
  try {
    await storage.acquireEpoch({ holder: "a", at: T0 });
    await storage.applyOperation(op("seed", { changes: [create("task", "t1")] }));
    for (let i = 0; i < 40; i++) {
      await storage.applyOperation(op(`d${i}`, {
        changes: [{ type: "check", ref: { kind: "task", id: "t1" }, expectedRevision: 1 }],
        outbox: [{ deliveryId: `d${String(i).padStart(2, "0")}`, destination: "d", priority: 5, aggregate: { kind: "task", id: "t1" }, payload: {}, ...(i % 4 === 0 ? { orderingKey: "chain" } : {}) }],
      }));
    }
    const claimAll = async (claimant: string): Promise<string[]> => {
      const mine: string[] = [];
      for (let idle = 0; idle < 3;) {
        const got = await commitClaim(claimant);
        if (got.length === 0) idle += 1; else mine.push(...got);
      }
      return mine;
    };
    const commitClaim = async (claimant: string): Promise<string[]> => {
      for (let attempt = 0; attempt < 20; attempt++) {
        try { return (await storage.claimDeliveries({ epoch: 1, destination: "d", claimant, now: "2026-10-19T13:00:00.000Z", leaseMs: 3_600_000, limit: 3 })).map((c) => c.deliveryId); } catch (error) { if (!isStorageError(error, "retryable")) throw error; }
      }
      throw new Error("claim kept failing");
    };
    const all = (await Promise.all(Array.from({ length: 12 }, (_, i) => claimAll(`w${i}`)))).flat();
    assert.equal(all.length, new Set(all).size, `a delivery was claimed twice: ${all.sort().join()}`);
    assert.equal(all.filter((id) => Number(id.slice(1)) % 4 === 0).join(), "d00", "only the head of the ordering chain may be claimed");
    assert.equal(all.length, 30 + 1, "every free delivery was claimed exactly once");
  } finally { await close(); }
});

test("a claim skips a delivery another session holds locked instead of waiting for it", async () => {
  const { storage, schema, url, close } = await fresh({ lockTimeoutMs: 400 });
  const holder = new pg.Client({ connectionString: url });
  try {
    await storage.acquireEpoch({ holder: "a", at: T0 });
    await storage.applyOperation(op("seed", { changes: [create("task", "t1")] }));
    for (const id of ["d1", "d2", "d3"]) {
      await storage.applyOperation(op(`seed-${id}`, { changes: [{ type: "check", ref: { kind: "task", id: "t1" }, expectedRevision: 1 }], outbox: [{ deliveryId: id, destination: "d", priority: 5, aggregate: { kind: "task", id: "t1" }, payload: {} }] }));
    }
    await holder.connect();
    await holder.query(`SET search_path = ${schema}`);
    await holder.query("BEGIN");
    await holder.query("SELECT * FROM deliveries WHERE delivery_id = 'd1' FOR UPDATE");
    const started = Date.now();
    const claims = await storage.claimDeliveries({ epoch: 1, destination: "d", claimant: "w", now: "2026-10-19T13:00:00.000Z", leaseMs: 1000, limit: 5 });
    assert.deepEqual(claims.map((c) => c.deliveryId), ["d2", "d3"], "the locked delivery is skipped, the others are claimed");
    assert.ok(Date.now() - started < 300, "the claim must not wait for the locked row");
    await holder.query("ROLLBACK");
    assert.deepEqual((await storage.claimDeliveries({ epoch: 1, destination: "d", claimant: "w", now: "2026-10-19T13:00:00.000Z", leaseMs: 1000, limit: 5 })).map((c) => c.deliveryId), ["d1"]);
  } finally { await holder.end().catch(() => undefined); await close(); }
});

test("many concurrent operations get gap-free audit and delivery numbers, one per revision step", async () => {
  const { storage, close } = await fresh({ maxConnections: 10 });
  try {
    await storage.acquireEpoch({ holder: "a", at: T0 });
    await storage.applyOperation(op("seed", { changes: [create("counter", "c")] }));
    const total = 60;
    const results = await Promise.all(Array.from({ length: total }, (_, i) => commitOperation(storage, op(`w${i}`, {
      changes: [{ type: "check", ref: { kind: "counter", id: "c" }, expectedRevision: 1 }, create("item", `i${String(i).padStart(3, "0")}`)],
      audit: [{ type: "x", detail: { i } }, { type: "y", detail: { i } }],
      outbox: [{ deliveryId: `m${i}`, destination: "d", priority: 5, aggregate: { kind: "item", id: `i${String(i).padStart(3, "0")}` }, payload: {}, orderingKey: "k" }],
    }), { attempts: 50 })));
    const audit = await storage.listAudit({ afterSeq: 0, limit: 1000 });
    assert.deepEqual(audit.map((a) => a.seq), Array.from({ length: total * 2 }, (_, i) => i + 1));
    const seqs = (await Promise.all(Array.from({ length: total }, (_, i) => storage.getDelivery(`m${i}`)))).map((d) => d!.seq).sort((x, y) => x - y);
    assert.deepEqual(seqs, Array.from({ length: total }, (_, i) => i + 1));
    // an operation's two audit entries are adjacent: its numbers were taken together, in commit order
    for (const r of results) assert.equal(r.auditSeqs[1]! - r.auditSeqs[0]!, 1);
    // delivery order for the key equals audit order of the operations that created them
    const byDelivery = new Map(results.map((r, i) => [`m${i}`, r.auditSeqs[0]!]));
    const ordered = (await Promise.all(Array.from({ length: total }, (_, i) => storage.getDelivery(`m${i}`)))).sort((x, y) => x!.seq - y!.seq).map((d) => byDelivery.get(d!.deliveryId)!);
    assert.deepEqual(ordered, [...ordered].sort((x, y) => x - y), "delivery sequence must follow commit order");
  } finally { await close(); }
});

// ---- the schema enforces the contract by itself ---------------------------------------------------------------------
test("the schema itself enforces uniqueness, state rules and ordering collation", async () => {
  const { storage, schema, url, close } = await fresh();
  try {
    await storage.close();
    await withClient(url, async (c) => {
      await c.query(`SET search_path = ${schema}`);
      const bad = async (sql: string, message: string) => assert.rejects(c.query(sql), (e) => /^23/.test((e as { code?: string }).code ?? ""), message);
      await c.query("INSERT INTO operations VALUES ('o1', 'h', 'a', 'c', 't', '{}')");
      await bad("INSERT INTO operations VALUES ('o1', 'h2', 'a', 'c', 't', '{}')", "duplicate operation ID");
      await bad("INSERT INTO audit VALUES (1, 'missing-op', 'c', 'a', 't', 'x', NULL, NULL, '{}')", "audit without an operation");
      const delivery = (id: string, seq: number, state = "pending", priority = 5) =>
        `INSERT INTO deliveries (delivery_id, seq, destination, priority, aggregate_kind, aggregate_id, aggregate_revision, payload, state, attempts, next_attempt_at) VALUES ('${id}', ${seq}, 'd', ${priority}, 'k', 'i', 1, '{}', '${state}', 0, 't')`;
      await c.query(delivery("d1", 1));
      await bad(delivery("d1", 2), "duplicate delivery ID");
      await bad(delivery("d2", 1), "duplicate delivery sequence number");
      await bad(delivery("d3", 3, "weird"), "unknown delivery state");
      await bad(delivery("d4", 4, "pending", 10), "priority out of range");
      await c.query("INSERT INTO effects (effect_id, operation_id, target, input_digest, status, created_at, updated_at) VALUES ('e1', 'o1', 't', 'd', 'intended', 't', 't')");
      await bad("INSERT INTO effects (effect_id, operation_id, target, input_digest, status, created_at, updated_at) VALUES ('e1', 'o1', 't', 'd', 'intended', 't', 't')", "duplicate effect ID");
      await bad("INSERT INTO effects (effect_id, operation_id, target, input_digest, status, created_at, updated_at) VALUES ('e2', 'o1', 't', 'd', 'bogus', 't', 't')", "unknown effect status");
      await c.query("INSERT INTO timers (timer_id, due_at, payload, state, attempts) VALUES ('t1', 't', '{}', 'pending', 0)");
      await bad("INSERT INTO timers (timer_id, due_at, payload, state, attempts) VALUES ('t1', 't', '{}', 'pending', 0)", "duplicate timer ID");
      await bad("INSERT INTO aggregates VALUES ('k', 'i', 0, '{}', 't', 't')", "revision 0");
      await bad("INSERT INTO state VALUES (2, 0, NULL)", "second state row");
      const order = await c.query("SELECT x FROM (VALUES ('a1'), ('B1'), ('a10'), ('a2'), ('é')) AS t(x) ORDER BY x COLLATE \"C\"");
      assert.deepEqual(order.rows.map((r) => r.x), ["B1", "a1", "a10", "a2", "é"]);
      const ids = await c.query("SELECT a.attname FROM pg_attribute a JOIN pg_class c ON c.oid = a.attrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = $1 AND c.relname = 'deliveries' AND a.attnum > 0 AND a.atttypid = 'text'::regtype AND a.attcollation <> (SELECT oid FROM pg_collation WHERE collname = 'C' LIMIT 1)", [schema]);
      assert.deepEqual(ids.rows, [], "every text column of the deliveries table must use the C collation");
    });
  } finally { await dropSchema(url, schema); }
});

test("a constraint violation from an outside writer is reported as an invariant failure, not retried", async () => {
  const { storage, schema, url, close } = await fresh();
  try {
    await storage.acquireEpoch({ holder: "a", at: T0 });
    await storage.applyOperation(op("seed", { changes: [create("task", "t1")] }));
    await withClient(url, async (c) => {
      await c.query(`SET search_path = ${schema}`);
      await c.query("INSERT INTO deliveries (delivery_id, seq, destination, priority, aggregate_kind, aggregate_id, aggregate_revision, payload, state, attempts, next_attempt_at) VALUES ('foreign', 1, 'd', 5, 'task', 't1', 1, '{}', 'pending', 0, 't')");
    });
    let calls = 0;
    const counting = new Proxy(storage, { get: (target, name, receiver) => (name === "applyOperation" ? (input: OperationInput) => { calls++; return target.applyOperation(input); } : Reflect.get(target, name, receiver)) });
    const attempt = op("collides", { changes: [update("task", "t1", 1, { changed: 1 })], audit: [{ type: "x", detail: {} }], outbox: [{ deliveryId: "mine", destination: "d", priority: 5, aggregate: { kind: "task", id: "t1" }, payload: {} }] });
    await assert.rejects(commitOperation(counting, attempt, { attempts: 5 }), (e) => isStorageError(e, "unavailable") && /invariant violation/.test((e as Error).message));
    assert.equal(calls, 1);
    assert.equal((await storage.getAggregate({ kind: "task", id: "t1" }))?.revision, 1);
    assert.equal(await storage.getOperation("collides"), undefined);
  } finally { await close(); }
});

// ---- the server itself crashes ----------------------------------------------------------------------------------
test("a server killed by an immediate shutdown while work is in flight loses nothing it acknowledged, shows no partial operation, and the store recovers by itself", async () => {
  const s = await startEmbeddedServer(); // its own server: this test crashes it
  if (s.crashAndRestart === undefined) return;
  const schema = schemaName();
  const storage = await PostgresStorage.open({ connectionString: s.url(), schema, maxConnections: 4, lockTimeoutMs: 2000, connectTimeoutMs: 1000 });
  let stop = false;
  let writerDone: Promise<void> | undefined;
  // Raw failures of the storage's own calls, seen before commitOperation's bounded retries can hide them. (Stopping and restarting the
  // server blocks this process for a while, so the writer can only meet the outage in the first calls after the restart.)
  const rawFailures: string[] = [];
  const watched = new Proxy(storage, {
    get(target, name, receiver) {
      const value = Reflect.get(target, name, receiver) as unknown;
      if (typeof value !== "function" || typeof name !== "string" || name === "close") return value;
      return async (...args: unknown[]) => {
        try { return await (value as (...a: unknown[]) => Promise<unknown>).apply(target, args); } catch (error) { rawFailures.push(isStorageError(error) ? error.kind : "other"); throw error; }
      };
    },
  });
  try {
    await storage.acquireEpoch({ holder: "a", at: T0 });
    await storage.applyOperation(op("seed", { changes: [create("counter", "c", { n: 0 })] }));
    const acknowledged = new Set<string>();
    const attempted = new Set<string>();
    // One writer bumps the counter in a loop, as a controller would, riding out the outage the way a caller must:
    // retry `unavailable` after a pause, resolve everything else by operation ID.
    const writer = writerDone = (async () => {
      for (let i = 0; !stop; i++) {
        const id = `bump-${i}`;
        attempted.add(id);
        for (;;) {
          try {
            const current = await watched.getAggregate({ kind: "counter", id: "c" });
            const revision = current!.revision;
            const done = await watched.getOperation(id);
            if (done !== undefined) { acknowledged.add(id); break; }
            await commitOperation(watched, op(id, {
              changes: [update("counter", "c", revision, { n: i })], audit: [{ type: "bump", detail: { i } }],
              outbox: [{ deliveryId: id, destination: "d", priority: 5, aggregate: { kind: "counter", id: "c" }, payload: {} }],
            }), { attempts: 3 });
            acknowledged.add(id);
            break;
          } catch (error) {
            if (isStorageError(error, "revision_conflict")) continue; // the operation committed meanwhile with another number: resolved above
            if (isStorageError(error, "unavailable") || isStorageError(error, "retryable") || isStorageError(error, "uncertain_commit")) { await sleep(100); continue; }
            throw error;
          }
        }
        await sleep(5);
      }
    })();
    await sleep(500);
    const before = acknowledged.size;
    assert.ok(before >= 5, `only ${before} operations were acknowledged before the crash`);
    await s.crashAndRestart();
    await sleep(1000);
    const after = acknowledged.size;
    stop = true;
    await writer;
    // The crash broke the store's connections: at least one raw storage call failed because of it. (A fast restart can be ridden out by
    // the bounded retries without any error reaching the writer loop, which is why the failures are recorded below that layer.)
    assert.ok(rawFailures.some((k) => k === "retryable" || k === "uncertain_commit" || k === "unavailable"), `no storage call failed because of the crash (${rawFailures.join() || "none failed"}), so it did not happen while the store was connected`);
    assert.ok(after > before, "the store never resumed after the server restarted");

    // Every acknowledged operation is present; nothing is half there.
    const counter = (await storage.getAggregate({ kind: "counter", id: "c" }))!;
    const audits = (await storage.listAudit({ afterSeq: 0, limit: 1000 })).filter((a) => a.type === "bump");
    const deliveries = (await Promise.all([...attempted].map((id) => storage.getDelivery(id)))).filter((d) => d !== undefined);
    for (const id of acknowledged) assert.ok(await storage.getOperation(id) !== undefined, `acknowledged operation ${id} was lost`);
    assert.equal(counter.revision, 1 + audits.length, "one revision per applied operation");
    assert.equal(audits.length, deliveries.length, "audit entries and deliveries must agree: an operation was partly applied");
    assert.ok(audits.length >= acknowledged.size, "every acknowledged operation left its audit entry");
    assert.deepEqual((await storage.listAudit({ afterSeq: 0, limit: 1000 })).map((a) => a.seq), Array.from({ length: audits.length }, (_, i) => i + 1), "audit numbers must stay gap-free");
  } finally {
    stop = true;
    await writerDone?.catch(() => undefined);
    await storage.close().catch(() => undefined);
    await s.stop();
  }
});
