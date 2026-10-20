import assert from "node:assert/strict";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { test } from "node:test";
import { commitOperation, isStorageError, runStorageConformance, type OperationInput } from "../index.js";
import { classify } from "./errors.js";
import { networkFilesystemProblem } from "./filesystem.js";
import { SCHEMA_VERSION, SqliteStorage } from "./index.js";

const T0 = "2026-10-19T12:00:00.000Z";
const child = fileURLToPath(new URL("./testing/child.js", import.meta.url));
const guard = pathToFileURL(fileURLToPath(new URL("../../../../../scripts/offline-guard.mjs", import.meta.url))).href;
const scratch = (): string => mkdtempSync(join(tmpdir(), "nn sqlite-"));
const remove = (dir: string): void => rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
const op = (operationId: string, over: Partial<OperationInput> = {}): OperationInput => ({
  operationId, epoch: 1, actor: "test", correlationId: `c-${operationId}`, at: T0, changes: [], audit: [], outbox: [], effects: [], timers: [], cancelTimers: [],
  completeDeliveries: [], completeTimers: [], settleEffects: [], ...over,
});

// ---- the shared semantic fixtures, against a real database file ----------------------------------------------
const directories: string[] = [];
runStorageConformance({
  name: "SqliteStorage",
  open: async () => {
    const dir = scratch();
    directories.push(dir);
    const storage = await SqliteStorage.open({ path: join(dir, "controller.sqlite") });
    return { storage, close: async () => { await storage.close(); remove(dir); } };
  },
});

// ---- settings, schema, locations ---------------------------------------------------------------------------
test("durability and safety settings are applied and read back", async () => {
  const dir = scratch();
  try {
    const storage = await SqliteStorage.open({ path: join(dir, "db.sqlite"), busyTimeoutMs: 1234 });
    const settings = storage.settings();
    assert.deepEqual({ ...settings, sqliteVersion: "x" }, { sqliteVersion: "x", schemaVersion: SCHEMA_VERSION, journalMode: "wal", synchronous: "FULL", foreignKeys: true, busyTimeoutMs: 1234 });
    assert.match(settings.sqliteVersion, /^3\.\d+\.\d+/);
    await storage.close();
    // the settings are per connection and must be re-applied on every open
    const again = await SqliteStorage.open({ path: join(dir, "db.sqlite") });
    assert.equal(again.settings().synchronous, "FULL");
    await again.close();
  } finally { remove(dir); }
});

test("a reopened database keeps everything that was committed", async () => {
  const dir = scratch();
  try {
    const path = join(dir, "db.sqlite");
    const first = await SqliteStorage.open({ path });
    await first.acquireEpoch({ holder: "a", at: T0 });
    await first.applyOperation(op("o1", { changes: [{ type: "create", ref: { kind: "task", id: "t1" }, body: { a: 1 } }], audit: [{ type: "x", detail: {} }] }));
    await first.close();
    const second = await SqliteStorage.open({ path });
    assert.equal(await second.currentEpoch(), 1);
    assert.equal((await second.getAggregate({ kind: "task", id: "t1" }))?.revision, 1);
    assert.equal((await second.applyOperation(op("o1", { changes: [{ type: "create", ref: { kind: "task", id: "t1" }, body: { a: 1 } }], audit: [{ type: "x", detail: {} }] }))).replayed, true);
    await second.close();
  } finally { remove(dir); }
});

test("refuses a newer schema, a foreign database, and unsuitable paths, without changing the file", async () => {
  const dir = scratch();
  try {
    const newer = join(dir, "newer.sqlite");
    const seed = await SqliteStorage.open({ path: newer });
    await seed.close();
    const raw = new DatabaseSync(newer);
    raw.exec(`PRAGMA user_version = ${SCHEMA_VERSION + 1}`);
    raw.close();
    await assert.rejects(SqliteStorage.open({ path: newer }), (e) => isStorageError(e, "unavailable") && /newer than this version/.test((e as Error).message));

    const foreign = join(dir, "foreign.sqlite");
    const other = new DatabaseSync(foreign);
    other.exec("CREATE TABLE something_else (x)");
    other.close();
    await assert.rejects(SqliteStorage.open({ path: foreign }), (e) => isStorageError(e, "unavailable") && /did not create/.test((e as Error).message));
    const check = new DatabaseSync(foreign);
    assert.deepEqual(check.prepare("SELECT name FROM sqlite_schema WHERE type = 'table'").all().map((r) => r.name), ["something_else"]);
    check.close();

    writeFileSync(join(dir, "garbage.sqlite"), "this is not a database, just text that is long enough to look like a header....");
    await assert.rejects(SqliteStorage.open({ path: join(dir, "garbage.sqlite") }), (e) => isStorageError(e, "unavailable"));
    for (const path of [":memory:", "", "file:x.db"]) await assert.rejects(SqliteStorage.open({ path }), (e) => isStorageError(e, "invalid_input"), path);
    await assert.rejects(SqliteStorage.open({ path: join(dir, "x.sqlite"), busyTimeoutMs: -1 }), (e) => isStorageError(e, "invalid_input"));
  } finally { remove(dir); }
});

test("network locations are refused", async () => {
  assert.match(networkFilesystemProblem("\\\\fileserver\\share\\nn.sqlite") ?? "", /UNC/);
  assert.match(networkFilesystemProblem("//fileserver/share/nn.sqlite", "win32") ?? "", /UNC/);
  assert.equal(networkFilesystemProblem("//var/lib/nn/db.sqlite", "linux"), undefined, "a POSIX path may begin with two slashes");
  assert.equal(networkFilesystemProblem("//var/lib/nn/db.sqlite", "darwin"), undefined);
  assert.equal(networkFilesystemProblem("//?/C:/data/nn.sqlite", "win32"), undefined);
  assert.equal(networkFilesystemProblem("\\\\?\\C:\\data\\nn.sqlite"), undefined, "an extended-length local path is not a network path");
  assert.equal(networkFilesystemProblem(join(tmpdir(), "nn.sqlite")), undefined);
  await assert.rejects(SqliteStorage.open({ path: "\\\\fileserver\\share\\nn.sqlite" }), (e) => isStorageError(e, "unavailable") && /network file system/.test((e as Error).message));
  if (process.platform === "linux" && existsSync("/proc/self/mounts")) {
    // Every directory of this machine that is not a known network mount must pass; /proc itself is not a network mount either.
    assert.equal(networkFilesystemProblem("/proc/nn.sqlite"), undefined);
  }
});

test("the schema itself enforces the contract's uniqueness and state rules, whatever the code does", async () => {
  const dir = scratch();
  try {
    const path = join(dir, "db.sqlite");
    const storage = await SqliteStorage.open({ path });
    await storage.close();
    const raw = new DatabaseSync(path);
    raw.exec("PRAGMA foreign_keys = ON");
    const bad = (sql: string, message: string) => assert.throws(() => raw.exec(sql), /constraint|CHECK|UNIQUE|FOREIGN/i, message);
    raw.exec("INSERT INTO operations VALUES ('o1', 'h', 'a', 'c', 't', '{}')");
    bad("INSERT INTO operations VALUES ('o1', 'h2', 'a', 'c', 't', '{}')", "duplicate operation ID");
    bad("INSERT INTO audit VALUES (1, 'missing-op', 'c', 'a', 't', 'x', NULL, NULL, '{}')", "audit without an operation");
    const delivery = (id: string, seq: number, state = "pending", priority = 5) =>
      `INSERT INTO deliveries (delivery_id, seq, destination, priority, aggregate_kind, aggregate_id, aggregate_revision, payload, state, attempts, next_attempt_at) VALUES ('${id}', ${seq}, 'd', ${priority}, 'k', 'i', 1, '{}', '${state}', 0, 't')`;
    raw.exec(delivery("d1", 1));
    bad(delivery("d1", 2), "duplicate delivery ID");
    bad(delivery("d2", 1), "duplicate delivery sequence number");
    bad(delivery("d3", 3, "weird"), "unknown delivery state");
    bad(delivery("d4", 4, "pending", 10), "priority out of range");
    raw.exec("INSERT INTO effects (effect_id, operation_id, target, input_digest, status, created_at, updated_at) VALUES ('e1', 'o1', 't', 'd', 'intended', 't', 't')");
    bad("INSERT INTO effects (effect_id, operation_id, target, input_digest, status, created_at, updated_at) VALUES ('e1', 'o1', 't', 'd', 'intended', 't', 't')", "duplicate effect ID");
    bad("INSERT INTO effects (effect_id, operation_id, target, input_digest, status, created_at, updated_at) VALUES ('e2', 'o1', 't', 'd', 'bogus', 't', 't')", "unknown effect status");
    raw.exec("INSERT INTO timers (timer_id, due_at, payload, state, attempts) VALUES ('t1', 't', '{}', 'pending', 0)");
    bad("INSERT INTO timers (timer_id, due_at, payload, state, attempts) VALUES ('t1', 't', '{}', 'pending', 0)", "duplicate timer ID");
    bad("INSERT INTO aggregates VALUES ('k', 'i', 0, '{}', 't', 't')", "revision 0");
    bad("INSERT INTO state VALUES (2, 0, NULL, 0, 0)", "second state row");
    raw.close();
  } finally { remove(dir); }
});

test("a constraint violation is reported as an invariant failure, never as something to retry", async () => {
  const classified = (code: number) => classify(Object.assign(new Error("UNIQUE constraint failed: deliveries.seq"), { code: "ERR_SQLITE_ERROR", errcode: code, errstr: "constraint failed" }));
  for (const code of [19, 1555, 2067, 275, 787, 1299]) {
    const error = classified(code);
    assert.equal(error.kind, "unavailable", `extended code ${code}`);
    assert.match(error.message, /invariant violation/);
    assert.match(error.message, new RegExp(`extended code ${code}`));
  }
  assert.equal(classify(Object.assign(new Error("busy"), { code: "ERR_SQLITE_ERROR", errcode: 5 })).kind, "retryable");
  assert.equal(classify(Object.assign(new Error("busy"), { code: "ERR_SQLITE_ERROR", errcode: 261 })).kind, "retryable");
  assert.equal(classify(Object.assign(new Error("locked"), { code: "ERR_SQLITE_ERROR", errcode: 6 })).kind, "retryable");

  // The realistic way to hit one: another program writes a row the adapter's own counters do not know about.
  const dir = scratch();
  try {
    const path = join(dir, "db.sqlite");
    const first = await SqliteStorage.open({ path });
    await first.acquireEpoch({ holder: "a", at: T0 });
    await first.applyOperation(op("seed", { changes: [{ type: "create", ref: { kind: "task", id: "t1" }, body: {} }] }));
    await first.close();
    const outsider = new DatabaseSync(path);
    outsider.exec("INSERT INTO deliveries (delivery_id, seq, destination, priority, aggregate_kind, aggregate_id, aggregate_revision, payload, state, attempts, next_attempt_at) VALUES ('foreign', 1, 'd', 5, 'task', 't1', 1, '{}', 'pending', 0, 't')");
    outsider.close();
    const storage = await SqliteStorage.open({ path });
    const attempt = op("collides", { changes: [{ type: "update", ref: { kind: "task", id: "t1" }, expectedRevision: 1, body: { changed: true } }], audit: [{ type: "x", detail: {} }], outbox: [{ deliveryId: "mine", destination: "d", priority: 5, aggregate: { kind: "task", id: "t1" }, payload: {} }] });
    let calls = 0;
    const counting = new Proxy(storage, { get: (target, name, receiver) => (name === "applyOperation" ? (input: OperationInput) => { calls++; return target.applyOperation(input); } : Reflect.get(target, name, receiver)) });
    await assert.rejects(commitOperation(counting, attempt, { attempts: 5 }), (e) => isStorageError(e, "unavailable") && /invariant violation/.test((e as Error).message));
    assert.equal(calls, 1, "an invariant violation must fail fast, not be retried");
    assert.equal((await storage.getAggregate({ kind: "task", id: "t1" }))?.revision, 1, "the failed operation rolled back completely");
    assert.equal(await storage.getOperation("collides"), undefined);
    await storage.close();
  } finally { remove(dir); }
});

// ---- bounded busy handling and rollback ------------------------------------------------------------------------
function holdLock(database: string): Promise<{ release(): Promise<void> }> {
  return new Promise((resolve, reject) => {
    const holder: ChildProcess = spawn(process.execPath, ["--import", guard, child, "hold-lock", database], { stdio: ["pipe", "pipe", "inherit"] });
    holder.on("error", reject);
    holder.stdout!.once("data", () => resolve({ release: () => new Promise((done) => { holder.on("exit", () => done()); holder.stdin!.end(); }) }));
  });
}

test("a writer blocked by another process fails as retryable within the bound, leaves nothing behind, and succeeds once the lock is gone", async () => {
  const dir = scratch();
  try {
    const path = join(dir, "db.sqlite");
    const storage = await SqliteStorage.open({ path, busyTimeoutMs: 300 });
    await storage.acquireEpoch({ holder: "a", at: T0 });
    const lock = await holdLock(path);
    const started = Date.now();
    await assert.rejects(storage.applyOperation(op("blocked", { changes: [{ type: "create", ref: { kind: "task", id: "t1" }, body: {} }], audit: [{ type: "x", detail: {} }] })), (e) => isStorageError(e, "retryable"));
    const waited = Date.now() - started;
    assert.ok(waited >= 250 && waited < 5000, `waited ${waited} ms for a 300 ms bound`);
    assert.equal(await storage.getAggregate({ kind: "task", id: "t1" }), undefined, "readers still work while a writer waits, and see nothing from the failed write");
    await assert.rejects(storage.claimDeliveries({ epoch: 1, destination: "d", claimant: "w", now: T0, leaseMs: 1000, limit: 1 }), (e) => isStorageError(e, "retryable"));
    await lock.release();
    const result = await commitOperation(storage, op("blocked", { changes: [{ type: "create", ref: { kind: "task", id: "t1" }, body: {} }], audit: [{ type: "x", detail: {} }] }));
    assert.equal(result.replayed, false);
    assert.equal((await storage.listAudit({ afterSeq: 0, limit: 10 })).length, 1);
    await storage.close();
  } finally { remove(dir); }
});

// ---- contention between processes -------------------------------------------------------------------------------
function runChild(...args: string[]): Promise<{ code: number | null; out: string[]; err: string }> {
  return new Promise((resolve, reject) => {
    const proc = spawn(process.execPath, ["--import", guard, child, ...args], { stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    let err = "";
    proc.stdout.on("data", (d: Buffer) => { out += d.toString(); });
    proc.stderr.on("data", (d: Buffer) => { err += d.toString(); });
    proc.on("error", reject);
    proc.on("exit", (code) => resolve({ code, out: out.split("\n").filter(Boolean), err }));
  });
}

test("several processes bumping one counter lose no update, keep audit and delivery numbers gap-free, and each revision has one winner", async () => {
  const dir = scratch();
  try {
    const path = join(dir, "db.sqlite");
    const setup = await SqliteStorage.open({ path });
    await setup.acquireEpoch({ holder: "a", at: T0 });
    await setup.applyOperation(op("seed", { changes: [{ type: "create", ref: { kind: "counter", id: "c" }, body: { n: 0 } }] }));
    await setup.close();
    const workers = ["w1", "w2", "w3", "w4"];
    const perWorker = 15;
    const runs = await Promise.all(workers.map((w) => runChild("counter", path, w, String(perWorker))));
    for (const r of runs) assert.equal(r.code, 0, r.err);
    const check = await SqliteStorage.open({ path });
    const total = workers.length * perWorker;
    assert.equal((await check.getAggregate({ kind: "counter", id: "c" }))?.revision, total + 1);
    const audit = await check.listAudit({ afterSeq: 0, limit: 1000 });
    assert.deepEqual(audit.map((a) => a.seq), Array.from({ length: total }, (_, i) => i + 1));
    const seqs = await Promise.all(workers.flatMap((w) => Array.from({ length: perWorker }, (_, i) => check.getDelivery(`${w}-${i}`).then((d) => d?.seq))));
    assert.deepEqual([...seqs].sort((a, b) => a! - b!), Array.from({ length: total }, (_, i) => i + 1), "delivery sequence numbers must be unique and gap-free");
    const revisions = await Promise.all(workers.flatMap((w) => Array.from({ length: perWorker }, (_, i) => check.getDelivery(`${w}-${i}`).then((d) => d?.aggregateRevision))));
    assert.equal(new Set(revisions).size, total, "two operations were committed against the same revision");
    await check.close();
  } finally { remove(dir); }
});

test("competing processes never receive the same delivery, and together receive all of them", async () => {
  const dir = scratch();
  try {
    const path = join(dir, "db.sqlite");
    const setup = await SqliteStorage.open({ path });
    await setup.acquireEpoch({ holder: "a", at: T0 });
    await setup.applyOperation(op("seed", { changes: [{ type: "create", ref: { kind: "counter", id: "c" }, body: {} }] }));
    for (let i = 0; i < 30; i++) {
      await setup.applyOperation(op(`d${i}`, {
        changes: [{ type: "check", ref: { kind: "counter", id: "c" }, expectedRevision: 1 }],
        outbox: [{ deliveryId: `d${String(i).padStart(2, "0")}`, destination: "d", priority: 5, aggregate: { kind: "counter", id: "c" }, payload: {}, ...(i % 3 === 0 ? { orderingKey: "chain" } : {}) }],
      }));
    }
    await setup.close();
    const runs = await Promise.all(["p1", "p2", "p3", "p4"].map((p) => runChild("claim", path, p)));
    for (const r of runs) assert.equal(r.code, 0, r.err);
    const claimed = runs.flatMap((r) => r.out.filter((l) => l.startsWith("claimed ")).map((l) => l.slice(8)));
    assert.equal(claimed.length, new Set(claimed).size, "a delivery was claimed twice");
    // The ten keyed messages form one chain; with nobody completing them only its head can ever be claimed.
    const keyed = claimed.filter((id) => Number(id.slice(1)) % 3 === 0);
    assert.deepEqual(keyed, ["d00"]);
    assert.equal(claimed.length, 20 + 1);
  } finally { remove(dir); }
});

// ---- process crash --------------------------------------------------------------------------------------------
test("killing a writer at arbitrary moments never leaves a partial operation, and acknowledged operations survive", async () => {
  const dir = scratch();
  try {
    const path = join(dir, "db.sqlite");
    const setup = await SqliteStorage.open({ path });
    await setup.acquireEpoch({ holder: "a", at: T0 });
    await setup.applyOperation(op("seed", { changes: [{ type: "create", ref: { kind: "counter", id: "c" }, body: { i: 0 } }] }));
    await setup.close();

    let stored = 0;
    for (const killAfter of [1, 4, 9, 2, 17, 6]) {
      const proc = spawn(process.execPath, ["--import", guard, child, "ack-loop", path], { stdio: ["ignore", "pipe", "inherit"] });
      let acked = 0;
      await new Promise<void>((resolve, reject) => {
        proc.on("error", reject);
        proc.on("exit", () => resolve());
        proc.stdout.on("data", (chunk: Buffer) => {
          acked += chunk.toString().split("\n").filter((l) => l.startsWith("acked")).length;
          if (acked >= killAfter) proc.kill("SIGKILL");
        });
      });
      const store = await SqliteStorage.open({ path });
      const counter = (await store.getAggregate({ kind: "counter", id: "c" }))!;
      const audits = (await store.listAudit({ afterSeq: 0, limit: 1000 })).filter((a) => a.type === "counter.bumped").length;
      let deliveries = 0;
      let effects = 0;
      for (let i = 1; i <= counter.revision + 1; i++) {
        if ((await store.getDelivery(`loop-${i}`)) !== undefined) deliveries++;
        if ((await store.getEffect(`loop-${i}`)) !== undefined) effects++;
      }
      assert.equal(counter.revision - 1, audits, "the aggregate and its audit entries disagree: a partial operation is visible");
      assert.equal(audits, deliveries, "audit and outbox disagree");
      assert.equal(audits, effects, "audit and effect records disagree");
      assert.ok(audits >= stored + acked, `an acknowledged operation was lost: ${audits} stored, expected at least ${stored + acked}`);
      assert.ok(audits <= stored + acked + 1, `more than the one in-flight operation appeared: ${audits} stored, ${stored + acked} acknowledged`);
      stored = audits;
      await store.close();
    }
    // The database still accepts work, and the operation that was in flight at the last kill is resolved by its stable ID.
    const store = await SqliteStorage.open({ path });
    const next = (await store.getAggregate({ kind: "counter", id: "c" }))!;
    const again = op(`loop-${next.revision}`, { changes: [{ type: "update", ref: { kind: "counter", id: "c" }, expectedRevision: next.revision, body: { resumed: true } }], audit: [{ type: "counter.bumped", detail: {} }] });
    assert.equal((await commitOperation(store, again)).replayed, false);
    assert.equal((await commitOperation(store, again)).replayed, true);
    await store.close();
    assert.ok(stored >= 6 + 1 - 1);
  } finally { remove(dir); }
});

test("a process killed while it holds the write lock releases it", async () => {
  const dir = scratch();
  try {
    const path = join(dir, "db.sqlite");
    const storage = await SqliteStorage.open({ path, busyTimeoutMs: 200 });
    await storage.acquireEpoch({ holder: "a", at: T0 });
    const lockHolder = spawn(process.execPath, ["--import", guard, child, "hold-lock", path], { stdio: ["pipe", "pipe", "inherit"] });
    await new Promise<void>((resolve) => lockHolder.stdout.once("data", () => resolve()));
    await assert.rejects(storage.applyOperation(op("x", { audit: [{ type: "x", detail: {} }] })), (e) => isStorageError(e, "retryable"));
    lockHolder.kill("SIGKILL");
    await new Promise((resolve) => lockHolder.on("exit", resolve));
    const result = await commitOperation(storage, op("x", { audit: [{ type: "x", detail: {} }] }), { attempts: 10 });
    assert.equal(result.replayed, false);
    await storage.close();
  } finally { remove(dir); }
});

test("the compiled child fixture exists where the build puts it and rejects an unknown mode", () => {
  assert.ok(existsSync(child), "the compiled child fixture is missing");
  const dir = scratch();
  try {
    const probe = spawnSync(process.execPath, [child, "nope", join(dir, "probe.sqlite")], { encoding: "utf8", timeout: 20_000 });
    assert.notEqual(probe.status, 0);
  } finally { remove(dir); }
});
