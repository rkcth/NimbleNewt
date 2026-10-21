import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { commitOperation, isStorageError, runStorageConformance, type OperationInput } from "../index.js";
import { registry } from "../qualification/migration-registry.js";
import { LATEST_VERSION, SqliteStorage, SqliteWorkerStorage } from "./index.js";

const T0 = "2026-10-19T12:00:00.000Z";
const child = fileURLToPath(new URL("./testing/child.js", import.meta.url));
const idleChild = fileURLToPath(new URL("./testing/idle-child.js", import.meta.url));
const guard = pathToFileURL(fileURLToPath(new URL("../../../../../scripts/offline-guard.mjs", import.meta.url))).href;
const scratch = (): string => mkdtempSync(join(tmpdir(), "nn sqlite-worker-"));
const remove = (dir: string): void => rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
const op = (operationId: string, over: Partial<OperationInput> = {}): OperationInput => ({
  operationId, epoch: 1, actor: "test", correlationId: `c-${operationId}`, at: T0, changes: [], audit: [], outbox: [], effects: [], timers: [], cancelTimers: [],
  completeDeliveries: [], completeTimers: [], settleEffects: [], ...over,
});
const create = (id: string): OperationInput => op(`create-${id}`, { changes: [{ type: "create", ref: { kind: "task", id }, body: { id } }], audit: [{ type: "task.created", detail: { id } }] });

// ---- the shared semantic fixtures: the worker must behave exactly as the in-thread adapter -----------------------
const directories: string[] = [];
runStorageConformance({
  name: "SqliteWorkerStorage",
  open: async () => {
    const dir = scratch();
    directories.push(dir);
    const storage = await SqliteWorkerStorage.open({ path: join(dir, "controller.sqlite") });
    return { storage, close: async () => { await storage.close(); remove(dir); } };
  },
});
runStorageConformance({
  name: "SqliteWorkerStorage (upgraded through synthetic migrations 2 and 3)",
  open: async () => {
    const dir = scratch();
    directories.push(dir);
    const path = join(dir, "controller.sqlite");
    await (await SqliteWorkerStorage.open({ path, migrations: registry("sqlite", "v1") })).close();
    const storage = await SqliteWorkerStorage.open({ path, migrations: registry("sqlite", "v123") });
    return { storage, close: async () => { await storage.close(); remove(dir); } };
  },
});

test("the durability settings in force on the worker are the same as in-thread, and are read back", async () => {
  const dir = scratch();
  try {
    const storage = await SqliteWorkerStorage.open({ path: join(dir, "db.sqlite"), busyTimeoutMs: 1234 });
    const settings = await storage.settings();
    assert.deepEqual({ ...settings, sqliteVersion: "x" }, { sqliteVersion: "x", schemaVersion: LATEST_VERSION, journalMode: "wal", synchronous: "FULL", foreignKeys: true, busyTimeoutMs: 1234 });
    assert.match(storage.path, /db\.sqlite$/);
    await storage.close();
  } finally { remove(dir); }
});

test("a refusal while opening comes back with its original kind and message, and no thread is left running", async () => {
  await assert.rejects(SqliteWorkerStorage.open({ path: ":memory:" }), (e) => isStorageError(e, "invalid_input") && /':memory:'/.test((e as Error).message));
  await assert.rejects(SqliteWorkerStorage.open({ path: "x.sqlite", busyTimeoutMs: -1 }), (e) => isStorageError(e, "invalid_input"));
  const dir = scratch();
  try {
    const path = join(dir, "db.sqlite");
    await (await SqliteStorage.open({ path, migrations: registry("sqlite", "v123") })).close();
    await assert.rejects(SqliteWorkerStorage.open({ path, migrations: registry("sqlite", "v1") }), (e) => isStorageError(e, "unavailable") && /newer/i.test((e as Error).message));
    await assert.rejects(SqliteWorkerStorage.open({ path: join(dir, "x.sqlite"), migrations: [{ version: 1, name: "bad", statements: ["NOT SQL"] }] }), (e) => isStorageError(e, "unavailable"));
  } finally { remove(dir); }
});

test("input that cannot be copied to the worker is refused as invalid_input and the store keeps working", async () => {
  const dir = scratch();
  try {
    const storage = await SqliteWorkerStorage.open({ path: join(dir, "db.sqlite") });
    await storage.acquireEpoch({ holder: "a", at: T0 });
    const bad = { ...create("t1"), correlationId: (() => 1) as unknown as string };
    await assert.rejects(storage.applyOperation(bad), (e) => isStorageError(e, "invalid_input"));
    const cyclic: Record<string, unknown> = {};
    cyclic["self"] = cyclic;
    await assert.rejects(storage.applyOperation({ ...create("t1"), audit: [{ type: "x", detail: cyclic as never }] }), (e) => isStorageError(e, "invalid_input"));
    assert.equal((await storage.applyOperation(create("t1"))).replayed, false);
    assert.equal((await storage.getAggregate({ kind: "task", id: "t1" }))?.revision, 1);
    await storage.close();
  } finally { remove(dir); }
});

test("calls are answered in the order they were made, and calls after close fail as unavailable; close can be repeated", async () => {
  const dir = scratch();
  try {
    const storage = await SqliteWorkerStorage.open({ path: join(dir, "db.sqlite") });
    await storage.acquireEpoch({ holder: "a", at: T0 });
    const results = await Promise.all(Array.from({ length: 50 }, (_, i) => storage.applyOperation(create(`t${i}`))));
    assert.deepEqual(results.map((r) => r.auditSeqs[0]), Array.from({ length: 50 }, (_, i) => i + 1), "sequence numbers follow the call order");
    const last = storage.applyOperation(create("late"));
    const closing = [storage.close(), storage.close()];
    assert.equal(closing[0], closing[1], "concurrent closes share one close");
    assert.equal((await last).replayed, false, "a call made before close is answered");
    await Promise.all(closing);
    await storage.close();
    await assert.rejects(storage.getAggregate({ kind: "task", id: "t0" }), (e) => isStorageError(e, "unavailable") && /closed/.test((e as Error).message));
    const reopened = await SqliteWorkerStorage.open({ path: join(dir, "db.sqlite") });
    assert.equal((await reopened.getAggregate({ kind: "task", id: "late" }))?.revision, 1, "what was acknowledged before close is durable");
    await reopened.close();
  } finally { remove(dir); }
});

test("the controller's event loop keeps running while commits are made; in-thread, it cannot", async () => {
  const ticksDuring = async (open: (path: string) => Promise<SqliteWorkerStorage | SqliteStorage>): Promise<number> => {
    const dir = scratch();
    try {
      const storage = await open(join(dir, "db.sqlite"));
      await storage.acquireEpoch({ holder: "a", at: T0 });
      let ticks = 0;
      const timer = setInterval(() => { ticks += 1; }, 1);
      await Promise.all(Array.from({ length: 400 }, (_, i) => storage.applyOperation(create(`t${i}`))));
      clearInterval(timer);
      await storage.close();
      return ticks;
    } finally { remove(dir); }
  };
  assert.equal(await ticksDuring((path) => SqliteStorage.open({ path })), 0, "in-thread, every commit ran inside one turn of the event loop");
  assert.ok(await ticksDuring((path) => SqliteWorkerStorage.open({ path })) > 0, "with the worker, timers fired while commits were in flight");
});

test("an unclosed store does not keep the process alive", async () => {
  const dir = scratch();
  try {
    const exit = await new Promise<{ code: number | null; out: string }>((resolve, reject) => {
      const proc = spawn(process.execPath, ["--import", guard, idleChild, join(dir, "db.sqlite")], { stdio: ["ignore", "pipe", "inherit"] });
      let out = "";
      proc.stdout.on("data", (d: Buffer) => { out += d.toString(); });
      proc.on("error", reject);
      const timer = setTimeout(() => { proc.kill("SIGKILL"); reject(new Error("the process did not end by itself")); }, 20_000);
      proc.on("exit", (code) => { clearTimeout(timer); resolve({ code, out }); });
    });
    assert.deepEqual(exit, { code: 0, out: "opened\n" });
  } finally { remove(dir); }
});

// ---- a worker that stops without being asked -----------------------------------------------------------------------
test("a worker that stops at any statement of a write: the waiting write is uncertain, later calls are unavailable, the file is consistent, and a reopened store settles it by ID", async () => {
  let points = 0;
  let statements = 0;
  for (let ordinal = 1; ; ordinal++) {
    let finished = false;
    for (const when of ["before", "after"] as const) {
      const dir = scratch();
      try {
        const path = join(dir, "db.sqlite");
        const setup = await SqliteWorkerStorage.open({ path });
        await setup.acquireEpoch({ holder: "a", at: T0 });
        await setup.close();
        const storage = await SqliteWorkerStorage.open({ path, testCrash: { when, ordinal, mode: "exit" } });
        const attempt = create("t1");
        let outcome: "committed" | "uncertain";
        try {
          await storage.applyOperation(attempt);
          outcome = "committed";
          finished = true; // the plan never fired: this ordinal is past the last statement
        } catch (error) {
          assert.ok(isStorageError(error, "uncertain_commit"), `ordinal ${ordinal} ${when}: ${String(error)}`);
          outcome = "uncertain";
          points += 1;
          await assert.rejects(storage.getAggregate({ kind: "task", id: "t1" }), (e) => isStorageError(e, "unavailable"));
          await assert.rejects(storage.applyOperation(create("t2")), (e) => isStorageError(e, "unavailable"));
        }
        await storage.close();
        if (outcome === "committed") { statements = ordinal - 1; continue; }
        // A fresh store (a restart) sees all of the operation or none of it, and resubmitting the same ID ends in the same state.
        const fresh = await SqliteWorkerStorage.open({ path });
        const stored = await fresh.getOperation("create-t1");
        const aggregate = await fresh.getAggregate({ kind: "task", id: "t1" });
        const audits = await fresh.listAudit({ afterSeq: 0, limit: 10 });
        if (stored === undefined) assert.deepEqual([aggregate, audits.length], [undefined, 0], `ordinal ${ordinal} ${when}: a partial write is visible`);
        else assert.deepEqual([aggregate?.revision, audits.length], [1, 1], `ordinal ${ordinal} ${when}: a committed write is incomplete`);
        const again = await commitOperation(fresh, attempt);
        assert.equal(again.replayed, stored !== undefined);
        assert.equal((await fresh.listAudit({ afterSeq: 0, limit: 10 })).length, 1, "admitted exactly once");
        await fresh.close();
      } finally { remove(dir); }
    }
    if (finished) break;
    assert.ok(ordinal < 100, "the crash plan never ran out of statements");
  }
  assert.ok(statements >= 8 && points >= 2 * statements - 2, `${points} stop points over ${statements} statements`);
});

// ---- contention with another process ------------------------------------------------------------------------------
function holdLock(database: string): Promise<{ release(): Promise<void> }> {
  return new Promise((resolve, reject) => {
    const holder: ChildProcess = spawn(process.execPath, ["--import", guard, child, "hold-lock", database], { stdio: ["pipe", "pipe", "inherit"] });
    holder.on("error", reject);
    holder.stdout!.once("data", () => resolve({ release: () => new Promise((done) => { holder.on("exit", () => done()); holder.stdin!.end(); }) }));
  });
}

test("a writer blocked by another process fails as retryable within the bound while reads and the controller stay responsive, and succeeds once the lock is gone", async () => {
  const dir = scratch();
  try {
    const path = join(dir, "db.sqlite");
    const storage = await SqliteWorkerStorage.open({ path, busyTimeoutMs: 300 });
    await storage.acquireEpoch({ holder: "a", at: T0 });
    const lock = await holdLock(path);
    let ticks = 0;
    const timer = setInterval(() => { ticks += 1; }, 5);
    const started = Date.now();
    await assert.rejects(storage.applyOperation(create("t1")), (e) => isStorageError(e, "retryable"));
    clearInterval(timer);
    const waited = Date.now() - started;
    assert.ok(waited >= 250 && waited < 5000, `waited ${waited} ms for a 300 ms bound`);
    assert.ok(ticks >= 10, `the event loop ran only ${ticks} timer ticks while a write waited for the lock: it was blocked`);
    assert.equal(await storage.getAggregate({ kind: "task", id: "t1" }), undefined);
    await lock.release();
    assert.equal((await commitOperation(storage, create("t1"))).replayed, false);
    await storage.close();
  } finally { remove(dir); }
});

// ---- the worker keeps the controller's own thread free ---------------------------------------------------------------
// The reason for the worker thread (card F04f) is that a storage call which has to wait cannot stall the thread that serves everything
// else. This holds a write lock from outside so that the worker's write must wait out its busy timeout, and requires that the controller's
// thread keeps running timers meanwhile. It does not depend on how fast the machine is: the wait is long by construction, and a single
// timer tick during it is enough. In-thread storage would block the whole wait and see none.
test("a write that has to wait for a lock does not stop the controller's own thread", async () => {
  const dir = scratch();
  let holder: DatabaseSync | undefined;
  let storage: SqliteWorkerStorage | undefined;
  try {
    const path = join(dir, "db.sqlite");
    storage = await SqliteWorkerStorage.open({ path, busyTimeoutMs: 600 });
    await storage.acquireEpoch({ holder: "x", at: T0 });
    holder = new DatabaseSync(path);
    holder.exec("BEGIN IMMEDIATE");
    let ticks = 0;
    const timer = setInterval(() => { ticks += 1; }, 20);
    try {
      await assert.rejects(storage.applyOperation(create("blocked")), (e) => isStorageError(e, "retryable"));
    } finally { clearInterval(timer); }
    assert.ok(ticks >= 1, "the controller's thread ran no timer while the worker waited for the lock");
    holder.exec("ROLLBACK");
    holder.close();
    holder = undefined;
    await storage.applyOperation(create("after"));
  } finally { try { holder?.close(); } catch { /* already closed */ } await storage?.close().catch(() => undefined); remove(dir); }
});
