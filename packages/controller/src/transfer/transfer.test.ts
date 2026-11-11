import assert from "node:assert/strict";
import { existsSync, statSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { MaintenanceBarrier } from "../backup/barrier.js";
import { CONTROLLER_TABLES, PostgresStorage, discardPostgresTransferCopy, dropPostgresSchema, postgresDatabaseBytes, postgresSchemaExists } from "../storage/postgres/index.js";
import { postgresTargetDeps, transferTargetsFromConfig } from "./targets.js";
import { commitWhileWaiting, startTestServer, withClient, type TestServer } from "../storage/postgres/testing/server.js";
import { commitStateRowWhileWaiting, foreignChangeSurvives, makeForeignChange, schemaTables, stateHolder, tableRows } from "../storage/postgres/testing/transfer-copy.js";
import { SqliteStorage } from "../storage/sqlite/index.js";
import { SNAPSHOT_TABLES, type SnapshotRow, type SnapshotTable, type StorageSnapshot } from "../storage/snapshot.js";
import type { ControllerStorage, OperationInput } from "../storage/types.js";
import { DatabaseTransferService, INTEGRITY_KEY_FILE, writeAuthority, expectEpochOnFirstTake, acquireStateLock, withStateLock, assertNotFenced, guardStart, postgresFingerprint, readAuthority, readJournal, recordFirstStart, sqliteFingerprint, sqliteTarget, type TransferOptions, type TransferPoint, type TransferTarget } from "./index.js";

const AT = "2026-10-31T10:00:00.000Z";
let serverPromise: Promise<TestServer> | undefined;
const server = (): Promise<TestServer> => (serverPromise ??= startTestServer());
after(async () => { if (serverPromise !== undefined) await (await serverPromise).stop(); });

const op = (operationId: string, epoch: number, over: Partial<OperationInput> = {}): OperationInput => ({ operationId, epoch, actor: "owner:rob", correlationId: `c-${operationId}`, at: AT, changes: [], audit: [], outbox: [], effects: [], timers: [], cancelTimers: [], completeDeliveries: [], completeTimers: [], settleEffects: [], ...over });

/** A realistic little installation: tasks, a policy, a claimed delivery, a delivered one with a receipt, effects in three states, two timers (one claimed), an artifact and a recovery point. */
async function populate(storage: ControllerStorage): Promise<number> {
  const { epoch } = await storage.acquireEpoch({ holder: "c1", at: AT });
  await storage.applyOperation(op("op-1", epoch, {
    changes: [
      { type: "create", ref: { kind: "task", id: "task-a" }, body: { title: "café" } }, { type: "create", ref: { kind: "attempt", id: "att-1" }, body: { taskId: "task-a" } },
      { type: "create", ref: { kind: "policy", id: "installation" }, body: { profile: "derived" } },
      { type: "create", ref: { kind: "artifact", id: "art-aaaaaaaaaaaaaaaaaaaa" }, body: { entries: [{ digest: "sha256:" + "d".repeat(64) }] } },
      { type: "create", ref: { kind: "recovery-point", id: "rp-1" }, body: { attemptId: "att-1", taskId: "task-a", artifactId: "art-aaaaaaaaaaaaaaaaaaaa", checkpoint: "ck-1" } },
    ],
    audit: [{ type: "task.created", detail: {} }],
    outbox: [{ deliveryId: "dlv-1", destination: "inbox", priority: 5, aggregate: { kind: "task", id: "task-a" }, payload: { n: 1 } }, { deliveryId: "dlv-2", destination: "mail", priority: 5, aggregate: { kind: "task", id: "task-a" }, payload: { n: 2 } }],
    effects: [{ effectId: "eff-1", target: "repo:main", inputDigest: "a".repeat(64) }, { effectId: "eff-2", target: "repo:x", inputDigest: "b".repeat(64) }, { effectId: "eff-3", target: "repo:y", inputDigest: "c".repeat(64) }],
    timers: [{ timerId: "tm-1", dueAt: "2026-10-01T10:00:00.000Z", payload: {} }, { timerId: "tm-2", dueAt: "2026-12-01T10:00:00.000Z", payload: {} }],
  }));
  const claims = await storage.claimDeliveries({ epoch, destination: "inbox", claimant: "w", now: AT, leaseMs: 600_000, limit: 5 });
  const mail = await storage.claimDeliveries({ epoch, destination: "mail", claimant: "w", now: AT, leaseMs: 600_000, limit: 5 });
  await storage.claimDueTimers({ epoch, claimant: "w", now: "2026-10-31T10:00:00.000Z", leaseMs: 600_000, limit: 5 });
  await storage.applyOperation(op("op-2", epoch, { completeDeliveries: [{ deliveryId: "dlv-2", claimToken: mail[0]!.claimToken, receipt: { ok: true } }], settleEffects: [{ effectId: "eff-2", outcome: "confirmed" }, { effectId: "eff-3", outcome: "uncertain" }] }));
  assert.equal(claims.length, 1);
  return epoch;
}

const st = (f: { dir: string }): string => join(f.dir, "state");
interface Fixture { dir: string; src: SqliteStorage; srcPath: string; barrier: MaintenanceBarrier; epoch: number; cleanup: Array<() => Promise<void>> }
const fixture = async (): Promise<Fixture> => {
  const dir = mkdtempSync(join(tmpdir(), "nn-xfer-"));
  const srcPath = join(dir, "source.sqlite");
  const src = await SqliteStorage.open({ path: srcPath });
  const epoch = await populate(src);
  return { dir, src, srcPath, barrier: new MaintenanceBarrier(), epoch, cleanup: [] };
};
const finish = async (f: Fixture): Promise<void> => { for (const c of f.cleanup.reverse()) await c().catch(() => undefined); await f.src.close().catch(() => undefined); rmSync(f.dir, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 }); };

let counter = 0;
async function pgTarget(f: Fixture, name = "pg", extra: Partial<TransferTarget> = {}): Promise<TransferTarget> {
  const s = await server();
  const schema = `xf_${process.pid}_${counter++}_${Math.random().toString(36).slice(2, 6)}`;
  const drop = async (): Promise<void> => { await withClient(s.url(), async (c) => { await c.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`); }); };
  f.cleanup.push(drop);
  return { name, kind: "postgres", fingerprint: postgresFingerprint(s.url(), schema), open: () => PostgresStorage.open({ connectionString: s.url(), schema }), discard: drop, ...extra };
}
async function sqlTarget(f: Fixture, file: string, name = "sqlite2", extra: { freeBytes?: () => Promise<number | undefined> } = {}): Promise<TransferTarget> {
  const path = join(f.dir, file);
  const base = await sqliteTarget({ name, path, open: () => SqliteStorage.open({ path }), discard: async () => { rmSync(path, { force: true }); rmSync(`${path}-wal`, { force: true }); rmSync(`${path}-shm`, { force: true }); } });
  return { ...base, ...extra };
}
const service = async (f: Fixture, targets: TransferTarget[], over: Partial<TransferOptions> = {}): Promise<DatabaseTransferService> =>
  new DatabaseTransferService({ storage: f.src, source: { kind: "sqlite", fingerprint: await sqliteFingerprint(f.srcPath), name: "source" }, targets: () => targets, stateDirectory: st(f), barrier: f.barrier, now: () => new Date(AT), ...over });

async function rows(storage: ControllerStorage): Promise<Record<string, SnapshotRow[]>> {
  const snap = await storage.snapshot();
  try {
    const out: Record<string, SnapshotRow[]> = {};
    for (const table of SNAPSHOT_TABLES) { out[table] = []; let after: SnapshotRow | undefined; for (;;) { const page = await snap.read(table, { ...(after === undefined ? {} : { after }), limit: 3 }); out[table]!.push(...page); if (page.length < 3 || table === "state") break; after = page[page.length - 1]; } }
    return out;
  } finally { await snap.close(); }
}

test("SQLite to PostgreSQL: every record arrives, claims are released, uncertain actions stay uncertain, the source is fenced and the authority is the destination (card F04e)", async () => {
  const f = await fixture();
  try {
    const target = await pgTarget(f);
    const svc = await service(f, [target], { pageSize: 2 });
    const before = await rows(f.src);
    const plan = await svc.preview("pg");
    assert.equal(plan.ok, true, JSON.stringify(plan.findings));
    assert.equal(plan.direction, "sqlite to postgres");
    assert.equal(plan.claimsReleased, 2, "one claimed delivery and one claimed timer");
    assert.equal(plan.uncertainEffects, 1); assert.equal(plan.intendedEffects, 1);
    assert.ok(plan.bytesNeeded > plan.bytes);
    const done = await svc.apply("pg", plan.token);
    assert.equal(done.restartRequired, true);
    assert.equal(f.barrier.held, true, "the controller stays in maintenance until it is restarted on the new database");
    const dest = await target.open();
    try {
      const after = await rows(dest);
      for (const t of SNAPSHOT_TABLES) assert.equal(after[t]!.length, before[t]!.length, t);
      assert.equal(after["aggregates"]!.find((r) => r["id"] === "task-a")!["body"], before["aggregates"]!.find((r) => r["id"] === "task-a")!["body"], "bodies are byte for byte");
      const d1 = after["deliveries"]!.find((r) => r["delivery_id"] === "dlv-1")!;
      assert.equal(d1["state"], "pending"); assert.equal(d1["claimed_until"], null); assert.equal(d1["token"], null);
      assert.equal(after["deliveries"]!.find((r) => r["delivery_id"] === "dlv-2")!["state"], "delivered");
      assert.equal(after["timers"]!.find((r) => r["timer_id"] === "tm-1")!["state"], "pending");
      assert.equal((await dest.getEffect("eff-3"))?.status, "uncertain");
      assert.equal((await dest.getEffect("eff-1"))?.status, "intended");
      assert.equal(await dest.currentEpoch(), f.epoch);
    } finally { await dest.close(); }
    // The source is fenced: an old controller cannot write.
    await assert.rejects(f.src.applyOperation(op("late", f.epoch)), (e: { kind?: string }) => e.kind === "stale_epoch");
    const authority = await readAuthority(st(f));
    assert.equal(authority?.active.fingerprint, target.fingerprint); assert.equal(authority?.generation, 1);
    assert.equal((await readJournal(st(f)))?.phase, "switched");
    if (process.platform !== "win32") for (const name of ["database-transfer-journal.json", "storage-authority.json"]) assert.equal(statSync(join(st(f), name)).mode & 0o777, 0o600, name);
    // Only the destination may be started on now.
    await assert.rejects(guardStart(st(f), { fingerprint: await sqliteFingerprint(f.srcPath) }), /moved to pg/);
    await guardStart(st(f), { fingerprint: target.fingerprint });
    // The fence is also inside the database: the source refuses to start even where no authority file can be read, and with one that names the destination.
    await assert.rejects(assertNotFenced(undefined, { fingerprint: await sqliteFingerprint(f.srcPath) }, f.src), /left by database transfer/);
    await assert.rejects(assertNotFenced(st(f), { fingerprint: await sqliteFingerprint(f.srcPath) }, f.src), /not the authoritative one/);
  } finally { await finish(f); }
});

test("reverse transfer: PostgreSQL back to a new SQLite file keeps everything, including what the first move carried (card F04e)", async () => {
  const f = await fixture();
  try {
    const pg = await pgTarget(f);
    await (await service(f, [pg])).apply("pg", (await (await service(f, [pg])).preview("pg")).token);
    // The controller restarts on PostgreSQL: it takes the next epoch and records something.
    const live = await pg.open();
    try {
      const { epoch } = await live.acquireEpoch({ holder: "c2", at: AT });
      await live.applyOperation(op("op-pg", epoch, { changes: [{ type: "create", ref: { kind: "task", id: "task-b" }, body: { title: "later" } }], audit: [{ type: "task.created", detail: {} }] }));
      const back = await sqlTarget(f, "back.sqlite", "back");
      const barrier = new MaintenanceBarrier();
      const reverse = new DatabaseTransferService({ storage: live, source: { kind: "postgres", fingerprint: pg.fingerprint, name: "pg" }, targets: () => [back], stateDirectory: st(f), barrier, now: () => new Date(AT) });
      const plan = await reverse.preview("back");
      assert.equal(plan.direction, "postgres to sqlite"); assert.equal(plan.ok, true, JSON.stringify(plan.findings));
      assert.ok(plan.freeBytes !== undefined && plan.freeBytes > 0, "the SQLite side reports free room");
      await reverse.apply("back", plan.token);
      const dest = await back.open();
      try { assert.equal((await dest.getAggregate({ kind: "task", id: "task-b" }))?.body["title"], "later"); assert.equal((await dest.getAggregate({ kind: "task", id: "task-a" }))?.body["title"], "café"); assert.equal((await dest.getEffect("eff-3"))?.status, "uncertain"); } finally { await dest.close(); }
      assert.equal((await readAuthority(st(f)))?.generation, 2);
      // PostgreSQL has no data directory of its own: the fence in the database still keeps the old controller out.
      await assert.rejects(assertNotFenced(undefined, { fingerprint: pg.fingerprint }, live), /left by database transfer/);
      assert.equal((await readAuthority(st(f)))?.active.fingerprint, back.fingerprint);
    } finally { await live.close(); }
  } finally { await finish(f); }
});

test("a failure at any point before the fence leaves the source whole, takes the barrier down, empties the destination and records why; a retry then works (card F04e)", async () => {
  const points: TransferPoint[] = ["drained", "validated", ...SNAPSHOT_TABLES.map((t): TransferPoint => `copy:${t}`), "copied", "verified", "before-fence"];
  for (const point of points) {
    const f = await fixture();
    try {
      const target = await sqlTarget(f, "dest.sqlite");
      const before = await rows(f.src);
      let armed = true;
      const svc = await service(f, [target], { pageSize: 2, inject: (p) => { if (armed && p === point) throw new Error(`injected at ${p}`); } });
      const plan = await svc.preview("sqlite2");
      await assert.rejects(svc.apply("sqlite2", plan.token), new RegExp(`injected at ${point.replace(":", ":")}`), point);
      assert.deepEqual(await rows(f.src), before, `${point}: the source is byte for byte what it was (epoch included)`);
      assert.equal(f.barrier.held, false, `${point}: work can go on`);
      assert.equal(await readAuthority(st(f)), undefined, point);
      const journal = await readJournal(st(f));
      assert.equal(journal?.phase, "failed", point); assert.match(journal?.failure?.reason ?? "", /injected/);
      assert.equal(journal?.failure?.destinationClean, true);
      // A failed transfer whose destination was emptied (or never written) does not make that database unusable.
      await guardStart(st(f), { fingerprint: target.fingerprint });
      // The source still accepts writes with its own epoch.
      await f.src.applyOperation(op(`after-${point}`, f.epoch));
      armed = false;
      const second = await svc.preview("sqlite2");
      assert.equal(second.ok, true, `${point}: ${JSON.stringify(second.findings)}`);
      // The retry is refused only because the source recorded something since (the new operation), which is correct to run again from a new plan.
      await svc.apply("sqlite2", second.token);
      assert.equal((await readJournal(st(f)))?.phase, "switched", point);
    } finally { await finish(f); }
  }
});

test("a crash after the fence is settled at the next start: fenced first and journalled second, so only a journalled fence lets the destination finish; the source of an unjournalled one is abandoned and admitted (card F04e)", async () => {
  type Case = readonly [TransferPoint, "source" | "destination", "journal" | "finish" | "abandon" | "moved" | "incomplete"];
  const cases: Case[] = [["fenced", "destination", "incomplete"], ["fenced", "source", "abandon"], ["fencing-recorded", "destination", "finish"], ["fencing-recorded", "source", "abandon"], ["authority-written", "source", "moved"], ["authority-written", "destination", "finish"]];
  for (const [point, configured, expect] of cases) {
    const f = await fixture();
    try {
      const target = await sqlTarget(f, "dest.sqlite");
      const svc = await service(f, [target], { inject: (p) => { if (p === point) throw new Error("boom"); } });
      const plan = await svc.preview("sqlite2");
      await assert.rejects(svc.apply("sqlite2", plan.token), /fenced/);
      assert.equal(f.barrier.held, true, "fenced and not switched: the controller stays down");
      assert.equal((await readJournal(st(f)))?.phase, point === "fenced" ? "copying" : "fencing", point);
      const source = { fingerprint: await sqliteFingerprint(f.srcPath) }, dest = { fingerprint: target.fingerprint };
      const place = configured === "source" ? source : dest;
      const start = guardStart(st(f), place, () => new Date(AT));
      if (expect === "incomplete") await assert.rejects(start, /did not complete/);
      else if (expect === "moved") await assert.rejects(start, /moved to/);
      else assert.equal((await start).resolved, expect === "finish" ? "finished" : "abandoned", `${point} on ${configured}`);
      if (expect === "finish") { assert.equal((await readAuthority(st(f)))?.active.fingerprint, target.fingerprint); assert.equal((await readJournal(st(f)))?.phase, "switched"); await assert.rejects(guardStart(st(f), source), /will not start/); const d = await target.open(); try { await assertNotFenced(st(f), dest, d); } finally { await d.close(); } }
      if (expect === "abandon") {
        assert.equal(await readAuthority(st(f)), undefined); assert.equal((await readJournal(st(f)))?.phase, "abandoned");
        await assertNotFenced(st(f), source, f.src); // admitted although the holder says transferred-out
        // An authority file that names another database withdraws the admission (the files are read again under the lock).
        const authorityFile = join(st(f), "storage-authority.json");
        await writeAuthority(st(f), { format: 1, generation: 9, active: { kind: "sqlite", fingerprint: target.fingerprint, name: "elsewhere" }, transferId: "xfer-other", since: AT });
        await assert.rejects(assertNotFenced(st(f), source, f.src), /not the authoritative one/);
        rmSync(authorityFile);
        // ... and the normal epoch take puts a normal holder back.
        await f.src.acquireEpoch({ holder: "controller", at: AT });
        await assertNotFenced(undefined, source, f.src);
        await assert.rejects(guardStart(st(f), dest), /did not complete/);
      }
      if (expect === "incomplete" || expect === "moved") { /* nothing admitted */ }
    } finally { await finish(f); }
  }
});

test("two starts at once on a fenced source and its verified destination: the state folder's lock lets exactly one be admitted (card F04e)", async () => {
  const f = await fixture();
  try {
    const target = await sqlTarget(f, "dest.sqlite");
    const svc = await service(f, [target], { inject: (p) => { if (p === "fencing-recorded") throw new Error("boom"); } });
    await assert.rejects(svc.apply("sqlite2", (await svc.preview("sqlite2")).token), /fenced/);
    const source = { fingerprint: await sqliteFingerprint(f.srcPath) }, dest = { fingerprint: target.fingerprint };
    const d = await target.open();
    try {
      const attempt = (place: { fingerprint: string }, storage: ControllerStorage): Promise<void> => withStateLock(st(f), async () => { await guardStart(st(f), place); await assertNotFenced(st(f), place, storage); await new Promise((r) => setTimeout(r, 300)); }, { wait: true });
      const outcomes = await Promise.allSettled([attempt(source, f.src), attempt(dest, d)]);
      assert.equal(outcomes.filter((o) => o.status === "fulfilled").length, 1, JSON.stringify(outcomes.map((o) => o.status)));
      const authority = await readAuthority(st(f));
      // The admitted one agrees with the files: the destination only if the authority names it.
      assert.equal(outcomes[1]!.status === "fulfilled", authority?.active.fingerprint === target.fingerprint);
    } finally { await d.close(); }
    // A second apply while the folder is locked is refused at once.
    const release = await acquireStateLock(st(f), { wait: false });
    try { await assert.rejects(withStateLock(st(f), async () => undefined, { wait: false }), /using the transfer state folder/); } finally { await release(); }
  } finally { await finish(f); }
});

test("a full copy left by a failed transfer (no discard, state row written) carries a pending holder and never starts as a normal database; files are private (card F04e)", async () => {
  const f = await fixture();
  try {
    const inner = await sqlTarget(f, "dest.sqlite");
    const target: TransferTarget = { name: inner.name, kind: inner.kind, fingerprint: inner.fingerprint, open: inner.open, ...(inner.freeBytes === undefined ? {} : { freeBytes: inner.freeBytes }) };
    const svc = await service(f, [target], { inject: (p) => { if (p === "verified") throw new Error("lost the network"); } });
    await assert.rejects(svc.apply("sqlite2", (await svc.preview("sqlite2")).token), /lost the network/);
    const d = await target.open();
    try {
      await assert.rejects(assertNotFenced(undefined, { fingerprint: target.fingerprint }, d), /left by database transfer .*transfer-pending/);
      await assert.rejects(assertNotFenced(st(f), { fingerprint: target.fingerprint }, d), /not the authoritative one/);
    } finally { await d.close(); }
    if (process.platform !== "win32") for (const name of ["database-transfer-journal.json"]) assert.equal(statSync(join(st(f), name)).mode & 0o777, 0o600);
    if (process.platform !== "win32") assert.equal(statSync(st(f)).mode & 0o777, 0o700);
  } finally { await finish(f); }
});

test("a rollback stopped at any point is finished by the next start; nothing is left that only a hand edit could repair (card F04e)", async () => {
  for (const point of ["rollback:journal", "rollback:fenced", "rollback:authority"] as const) {
    const f = await fixture();
    try {
      const target = await sqlTarget(f, "dest.sqlite");
      await (await service(f, [target])).apply("sqlite2", (await (await service(f, [target])).preview("sqlite2")).token);
      const started = await startOnDestination(f, target, { inject: (p) => { if (p === point) throw new Error("crash"); } });
      await assert.rejects(started.svc.rollback(), /crash/);
      assert.equal((await readJournal(st(f)))?.phase, "rolling-back");
      const source = { fingerprint: await sqliteFingerprint(f.srcPath) }, dest = { fingerprint: target.fingerprint };
      await assert.rejects(guardStart(st(f), dest), /moved to/);
      assert.equal((await readJournal(st(f)))?.phase, "rolled-back", point);
      assert.equal((await readAuthority(st(f)))?.active.fingerprint, source.fingerprint, point);
      await guardStart(st(f), source);
      await assertNotFenced(st(f), source, f.src);
    } finally { await finish(f); }
  }
});

test("a write that slips in between the last check and the fence is found after the fence, the fence is lifted and nothing is switched; the same for a rollback (card F04e)", async () => {
  const f = await fixture();
  try {
    const target = await sqlTarget(f, "dest.sqlite");
    const svc = await service(f, [target], { inject: async (p) => { if (p === "before-fence") await f.src.applyOperation(op("slipped", f.epoch, { audit: [{ type: "x", detail: {} }] })); } });
    await assert.rejects(svc.apply("sqlite2", (await svc.preview("sqlite2")).token), /changed between the last check and the fence \(records were written\)/);
    assert.equal(await readAuthority(st(f)), undefined); assert.equal((await readJournal(st(f)))?.phase, "failed");
    assert.equal(f.barrier.held, true, "deposed: the controller must be restarted");
    const state = (await rows(f.src))["state"]![0]!;
    assert.equal(state["holder"], "c1", "the original holder is back, not a fence");
    await assertNotFenced(undefined, { fingerprint: await sqliteFingerprint(f.srcPath) }, f.src);
  } finally { await finish(f); }
  const g = await fixture();
  try {
    const target = await sqlTarget(g, "dest.sqlite");
    await (await service(g, [target])).apply("sqlite2", (await (await service(g, [target])).preview("sqlite2")).token);
    let live: ControllerStorage | undefined, liveEpoch = 0;
    const started = await startOnDestination(g, target, { inject: async (p) => { if (p === "rollback:journal" && live !== undefined) await live.applyOperation(op("slip", liveEpoch, { audit: [{ type: "x", detail: {} }] })); } });
    live = started.live; liveEpoch = started.epoch;
    await assert.rejects(started.svc.rollback(), /work was recorded on the new database while the rollback was being made/);
    assert.equal((await readJournal(st(g)))?.phase, "switched");
    assert.equal((await readAuthority(st(g)))?.active.fingerprint, target.fingerprint);
    assert.equal((await rows(live))["state"]![0]!["holder"], "c2", "the fence on the new database was lifted");
  } finally { await finish(g); }
});

test("the first start is noted only when it is the first and wrote no more than a start does; a start without the state folder in between blocks rollback (card F04e)", async () => {
  const f = await fixture();
  try {
    const target = await sqlTarget(f, "dest.sqlite");
    await (await service(f, [target])).apply("sqlite2", (await (await service(f, [target])).preview("sqlite2")).token);
    // A start that did not know the state folder takes the epoch and works.
    const blind = await target.open();
    try {
      const { epoch } = await blind.acquireEpoch({ holder: "c2", at: AT });
      await blind.applyOperation(op("blind-work", epoch, { audit: [{ type: "x", detail: {} }] }));
      const { epoch: second } = await blind.acquireEpoch({ holder: "c3", at: AT });
      assert.equal(second, epoch + 1);
      assert.equal(await recordFirstStart(st(f), { fingerprint: target.fingerprint }, blind), false, "not the first start any more");
      assert.equal((await readJournal(st(f)))?.firstStart, undefined);
      const svc = new DatabaseTransferService({ storage: blind, source: { kind: "sqlite", fingerprint: target.fingerprint, name: "dest" }, targets: () => [], stateDirectory: st(f), barrier: new MaintenanceBarrier(), now: () => new Date(AT) });
      await assert.rejects(svc.rollback(), /no clean record of the new database's first start/);
    } finally { await blind.close(); }
  } finally { await finish(f); }
  const g = await fixture();
  try {
    const target = await sqlTarget(g, "dest.sqlite");
    await (await service(g, [target])).apply("sqlite2", (await (await service(g, [target])).preview("sqlite2")).token);
    const live = await target.open();
    try {
      const { epoch } = await live.acquireEpoch({ holder: "c2", at: AT });
      for (let i = 0; i < 3; i++) await live.applyOperation(op(`many-${i}`, epoch, { audit: Array.from({ length: 100 }, () => ({ type: "x", detail: {} })).slice(0, 100) }));
      // 300 records is within a start's writes; far more is work.
      assert.equal(await recordFirstStart(st(g), { fingerprint: target.fingerprint }, live), true);
    } finally { await live.close(); }
  } finally { await finish(g); }
  const h = await fixture();
  try {
    const target = await sqlTarget(h, "dest.sqlite");
    await (await service(h, [target])).apply("sqlite2", (await (await service(h, [target])).preview("sqlite2")).token);
    const live = await target.open();
    try {
      const { epoch } = await live.acquireEpoch({ holder: "c2", at: AT });
      for (let i = 0; i < 11; i++) await live.applyOperation(op(`lots-${i}`, epoch, { audit: Array.from({ length: 100 }, () => ({ type: "x", detail: {} })) }));
      assert.equal(await recordFirstStart(st(h), { fingerprint: target.fingerprint }, live), false, "more than a start writes is work");
    } finally { await live.close(); }
  } finally { await finish(h); }
});

test("a destination that is no longer empty when the copy begins is refused before anything is written, and is not emptied (card F04e)", async () => {
  const f = await fixture();
  try {
    const inner = await sqlTarget(f, "dest.sqlite");
    let opens = 0, discards = 0;
    const target: TransferTarget = { ...inner, discard: async () => { discards += 1; }, open: async () => {
      const real = await inner.open(); opens += 1;
      if (opens === 3) await real.restoreRows("operations", [{ operation_id: "op-other", request_hash: "h", actor: "a", correlation_id: "c", at: AT, result: "{}" }]); // someone wrote after the plan was made
      return real;
    } };
    const svc = await service(f, [target]);
    await assert.rejects(svc.apply("sqlite2", (await svc.preview("sqlite2")).token), /already holds operations records/);
    assert.equal(discards, 0, "not ours to empty");
    assert.equal(f.barrier.held, false);
  } finally { await finish(f); }
});

/** A source that answers snapshots from edited rows, to prove each check refuses (the real stores cannot hold such rows). */
function doctored(real: ControllerStorage, edit: (table: SnapshotTable, rows: SnapshotRow[]) => SnapshotRow[]): Pick<ControllerStorage, "snapshot" | "acquireEpoch"> {
  return {
    acquireEpoch: (i) => real.acquireEpoch(i),
    snapshot: async (): Promise<StorageSnapshot> => {
      const s = await real.snapshot();
      return { schemaVersion: s.schemaVersion, close: () => s.close(), read: async (table, page) => { const all: SnapshotRow[] = []; let after: SnapshotRow | undefined; for (;;) { const p = await s.read(table, { ...(after === undefined ? {} : { after }), limit: 1000 }); all.push(...p); if (p.length < 1000 || table === "state") break; after = p[p.length - 1]; } return edit(table, all.map((r) => ({ ...r }))).filter((r) => page.after === undefined || compareKey(table, r, page.after) > 0).slice(0, page.limit); } };
    },
  };
}
const compareKey = (table: SnapshotTable, a: SnapshotRow, b: SnapshotRow): number => {
  const cols: Record<string, string[]> = { operations: ["operation_id"], aggregates: ["kind", "id"], audit: ["seq"], deliveries: ["delivery_id"], effects: ["effect_id"], timers: ["timer_id"], state: [] };
  for (const c of cols[table]!) { const x = a[c]!, y = b[c]!; if (x !== y) return x! < y! ? -1 : 1; }
  return 0;
};

test("the source is checked before anything is copied: IDs, counters, receipts, recovery points, artifact files and checkpoints (card F04e)", async () => {
  const f = await fixture();
  try {
    const target = await sqlTarget(f, "dest.sqlite");
    const cases: [string, (t: SnapshotTable, r: SnapshotRow[]) => SnapshotRow[], RegExp, Partial<TransferOptions>?][] = [
      ["an ID that is not valid", (t, r) => (t === "effects" ? r.map((x) => ({ ...x, effect_id: "bad id!" })) : r), /effects: effect_id .*not a valid ID/],
      ["a delivered message with no receipt", (t, r) => (t === "deliveries" ? r.map((x) => (x["state"] === "delivered" ? { ...x, receipt: null } : x)) : r), /delivered and has no receipt/],
      ["a receipt on an undelivered message", (t, r) => (t === "deliveries" ? r.map((x) => (x["state"] !== "delivered" ? { ...x, receipt: "{}" } : x)) : r), /has a receipt but is not delivered/],
      ["an audit counter that disagrees", (t, r) => (t === "state" ? r.map((x) => ({ ...x, audit_seq: 99 })) : r), /audit counter is 99/],
      ["a recovery point without its artifact", (t, r) => (t === "aggregates" ? r.filter((x) => x["kind"] !== "artifact") : r), /recovery point rp-1 names artifact/],
      ["a policy that is not an object", (t, r) => (t === "aggregates" ? r.map((x) => (x["kind"] === "policy" ? { ...x, body: "[1]" } : x)) : r), /body of installation is not a JSON object/],
      ["a timer with a bad time", (t, r) => (t === "timers" ? r.map((x) => ({ ...x, due_at: "tomorrow" })) : r), /due_at "tomorrow" is not a timestamp/],
      ["a missing artifact file", (_t, r) => r, /artifact file sha256:d+ is not in the artifact store/, { references: { artifacts: async (d) => [...d] } }],
      ["a missing checkpoint", (_t, r) => r, /checkpoint of recovery point rp-1 is not in the conversation store, or does not match it/, { references: { checkpoints: async (p) => p.map((x) => x.id) } }],
    ];
    for (const [name, edit, expect, extra] of cases) {
      const svc = await service(f, [target], { storage: doctored(f.src, edit), ...(extra ?? {}) });
      const plan = await svc.preview("sqlite2");
      assert.equal(plan.ok, false, name);
      assert.match(plan.findings.map((x) => x.text).join("|"), expect, name);
      await assert.rejects(svc.apply("sqlite2", plan.token), /transfer is not started/, name);
      assert.equal(f.barrier.held, false, name);
      assert.equal(await readJournal(st(f)), undefined, `${name}: nothing was started`);
    }
    // The clean source passes with only warnings.
    const ok = await (await service(f, [target])).preview("sqlite2");
    assert.equal(ok.ok, true); assert.ok(ok.findings.every((x) => x.severity === "warning"));
  } finally { await finish(f); }
});

test("the destination must be empty, of the same schema version and have room; the source is never touched by a refusal (card F04e)", async () => {
  const f = await fixture();
  try {
    // A destination a controller has owned.
    const used = await sqlTarget(f, "used.sqlite", "used");
    const u = await used.open(); await u.acquireEpoch({ holder: "old", at: AT }); await u.close();
    const planUsed = await (await service(f, [used])).preview("used");
    assert.equal(planUsed.ok, false); assert.match(planUsed.findings.map((x) => x.text).join("|"), /not empty/);
    // A schema version that differs.
    const skewed = await sqlTarget(f, "skew.sqlite", "skew");
    const svc = await service(f, [skewed], { storage: { acquireEpoch: (i) => f.src.acquireEpoch(i), snapshot: async () => { const s = await f.src.snapshot(); return { schemaVersion: s.schemaVersion + 1, read: (t, p) => s.read(t, p), close: () => s.close() }; } } });
    assert.match((await svc.preview("skew")).findings.map((x) => x.text).join("|"), /schema version/);
    // Capacity: too little room is refused (also when the destination is SQLite, the reverse direction); unknown room refuses SQLite and only warns for PostgreSQL.
    const tiny = await sqlTarget(f, "tiny.sqlite", "tiny", { freeBytes: async () => 10 });
    const t = await (await service(f, [tiny])).preview("tiny");
    assert.equal(t.ok, false); assert.match(t.findings.map((x) => x.text).join("|"), /not enough room at the destination: about \d+ bytes are needed .* and 10 are free/);
    const blind = await sqlTarget(f, "blind.sqlite", "blind", { freeBytes: async () => undefined });
    const b = await (await service(f, [blind])).preview("blind");
    assert.equal(b.ok, false); assert.match(b.findings.map((x) => x.text).join("|"), /capacity must be checked/);
    const pg = await pgTarget(f);
    const p = await (await service(f, [pg])).preview("pg");
    assert.equal(p.ok, true); assert.match(p.findings.map((x) => x.text).join("|"), /not checked from here/);
    // A partial copy in the destination is refused.
    const partial = await sqlTarget(f, "partial.sqlite", "partial");
    const pd = await partial.open(); await pd.restoreRows("operations", [{ operation_id: "op-x", request_hash: "h", actor: "a", correlation_id: "c", at: AT, result: "{}" }]); await pd.close();
    assert.match((await (await service(f, [partial])).preview("partial")).findings.map((x) => x.text).join("|"), /already holds operations records/);
    assert.equal(await f.src.currentEpoch(), f.epoch);
    assert.equal(f.barrier.held, false);
  } finally { await finish(f); }
});

test("a confirmation that is not the plan's, a target that is not configured, the database in use and a running barrier are refused (card F04e)", async () => {
  const f = await fixture();
  try {
    const target = await sqlTarget(f, "dest.sqlite");
    const svc = await service(f, [target, await sqliteTarget({ name: "self", path: f.srcPath, open: async () => f.src })]);
    await assert.rejects(svc.apply("sqlite2", "wrong"), /does not match the plan/);
    await assert.rejects(svc.apply("nowhere", "x"), /no database called nowhere/);
    await assert.rejects(svc.preview("self"), /database in use/);
    assert.deepEqual(svc.targets().map((x) => x.name), ["sqlite2"], "the database in use is never offered");
    const release = await f.barrier.raise("restore");
    await assert.rejects(svc.apply("sqlite2", (await svc.preview("sqlite2")).token), /already running/);
    await release();
    assert.equal(existsSync(join(st(f), "database-transfer-journal.json")), false);
  } finally { await finish(f); }
});

test("a source that records something while it is copied is not switched (card F04e)", async () => {
  const f = await fixture();
  try {
    const target = await sqlTarget(f, "dest.sqlite");
    const svc = await service(f, [target], { inject: async (p) => { if (p === "copied") await f.src.applyOperation(op("sneaky", f.epoch, { audit: [{ type: "x", detail: {} }] })); } });
    await assert.rejects(svc.apply("sqlite2", (await svc.preview("sqlite2")).token), /recorded something while it was being copied/);
    assert.equal(await readAuthority(st(f)), undefined); assert.equal(f.barrier.held, false);
    assert.equal((await readJournal(st(f)))?.phase, "failed");
  } finally { await finish(f); }
});

/** The controller that restarts on the destination: it takes the next epoch, finishes starting and notes its counters. */
async function startOnDestination(f: Fixture, target: TransferTarget, extra: Partial<TransferOptions> = {}): Promise<{ live: ControllerStorage; epoch: number; svc: DatabaseTransferService; barrier: MaintenanceBarrier }> {
  await guardStart(st(f), { fingerprint: target.fingerprint });
  const live = await target.open();
  f.cleanup.push(async () => { await live.close(); });
  await assertNotFenced(st(f), { fingerprint: target.fingerprint }, live);
  const { epoch } = await live.acquireEpoch({ holder: "c2", at: AT });
  await live.applyOperation(op("restart-record", epoch, { audit: [{ type: "host.recorded", detail: {} }] }));
  await recordFirstStart(st(f), { fingerprint: target.fingerprint }, live);
  const barrier = new MaintenanceBarrier();
  const svc = new DatabaseTransferService({ storage: live, source: { kind: "sqlite", fingerprint: target.fingerprint, name: target.name }, targets: () => [], stateDirectory: st(f), barrier, now: () => new Date(AT), ...extra });
  return { live, epoch, svc, barrier };
}

test("rollback, run on the controller that restarted on the new database, puts the source back although the restart wrote records; it is refused once work was recorded (card F04e)", async () => {
  const f = await fixture();
  try {
    const target = await sqlTarget(f, "dest.sqlite");
    await (await service(f, [target])).apply("sqlite2", (await (await service(f, [target])).preview("sqlite2")).token);
    const { svc, barrier, live } = await startOnDestination(f, target);
    const back = await svc.rollback();
    assert.equal(back.restartRequired, true); assert.equal(barrier.held, true);
    const authority = await readAuthority(st(f));
    assert.equal(authority?.active.fingerprint, await sqliteFingerprint(f.srcPath)); assert.equal(authority?.generation, 2);
    assert.equal((await readJournal(st(f)))?.phase, "rolled-back");
    const source = { fingerprint: await sqliteFingerprint(f.srcPath) };
    await guardStart(st(f), source);
    await assertNotFenced(st(f), source, f.src);
    // The new database is fenced inside itself and by the authority; the running controller on it can no longer write.
    await assert.rejects(guardStart(st(f), { fingerprint: target.fingerprint }), /moved to/);
    await assert.rejects(assertNotFenced(undefined, { fingerprint: target.fingerprint }, live), /left by database transfer/);
    await assert.rejects(live.applyOperation(op("late", back.restartRequired ? 99 : 1)), /epoch|stale/);
    await assert.rejects(svc.rollback(), /no switched transfer/);
  } finally { await finish(f); }
  const g = await fixture();
  try {
    const target = await sqlTarget(g, "dest.sqlite");
    await (await service(g, [target])).apply("sqlite2", (await (await service(g, [target])).preview("sqlite2")).token);
    const { svc, live, epoch, barrier } = await startOnDestination(g, target);
    await live.applyOperation(op("new-work", epoch, { effects: [{ effectId: "eff-new", target: "repo:z", inputDigest: "e".repeat(64) }], audit: [{ type: "x", detail: {} }] }));
    await assert.rejects(svc.rollback(), /recorded work since it started .*reverse transfer/);
    assert.equal(barrier.held, false, "a refused rollback leaves the controller running");
    assert.equal((await readAuthority(st(g)))?.active.fingerprint, target.fingerprint, "authority did not move");
    assert.equal((await readJournal(st(g)))?.phase, "switched");
  } finally { await finish(g); }
});

test("a transfer to a destination that was left partial, failed or abandoned never starts there; a switched journal without its authority file is an error; separate folders for each database and the state (card F04e)", async () => {
  const f = await fixture();
  try {
    // No discard (production targets have none): the failed copy leaves rows behind, and the state row (copied last) is missing, so the store looks empty.
    const inner = await sqlTarget(f, "sub/dest.sqlite");
    const target: TransferTarget = { name: inner.name, kind: inner.kind, fingerprint: inner.fingerprint, open: inner.open, ...(inner.freeBytes === undefined ? {} : { freeBytes: inner.freeBytes }) };
    const svc = await service(f, [target], { inject: (p) => { if (p === "copy:state") throw new Error("disk full"); } });
    await assert.rejects(svc.apply("sqlite2", (await svc.preview("sqlite2")).token), /disk full/);
    assert.equal((await readJournal(st(f)))?.phase, "failed"); assert.equal((await readJournal(st(f)))?.failure?.destinationClean, false);
    await assert.rejects(guardStart(st(f), { fingerprint: target.fingerprint }), /did not complete/);
    await guardStart(st(f), { fingerprint: await sqliteFingerprint(f.srcPath) });
    // A second transfer is refused until the partial copy is emptied.
    assert.match((await (await service(f, [target])).preview("sqlite2")).findings.map((x) => x.text).join("|"), /not empty|already holds|left by a transfer that did not finish/);
  } finally { await finish(f); }
  const g = await fixture();
  try {
    const target = await sqlTarget(g, "other/dest.sqlite");
    const svc = await service(g, [target]);
    await svc.apply("sqlite2", (await svc.preview("sqlite2")).token);
    rmSync(join(st(g), "storage-authority.json"));
    await assert.rejects(guardStart(st(g), { fingerprint: target.fingerprint }), /recorded as switched but the authority file/);
    await assert.rejects(guardStart(st(g), { fingerprint: await sqliteFingerprint(g.srcPath) }), /recorded as switched but the authority file/);
  } finally { await finish(g); }
});

test("an ambiguous fence (the epoch was taken, the answer lost) counts as fenced; a source changed in place is caught by the table digests; discard only runs when rows were written; the owner's switch is honoured (card F04e)", async () => {
  const f = await fixture();
  try {
    const target = await sqlTarget(f, "dest.sqlite");
    const lossy = { snapshot: () => f.src.snapshot(), acquireEpoch: async (i: Parameters<ControllerStorage["acquireEpoch"]>[0]) => { await f.src.acquireEpoch(i); throw new Error("connection reset after commit"); } };
    const svc = await service(f, [target], { storage: lossy });
    const done = await svc.apply("sqlite2", (await svc.preview("sqlite2")).token);
    assert.equal(done.restartRequired, true);
    assert.equal((await readJournal(st(f)))?.phase, "switched");
  } finally { await finish(f); }
  const g = await fixture();
  try {
    const target = await sqlTarget(g, "dest.sqlite");
    let changed = false;
    const svc = await service(g, [target], { storage: doctored(g.src, (t, r) => (changed && t === "aggregates" ? r.map((x) => (x["id"] === "task-a" ? { ...x, body: '{"title":"edited"}' } : x)) : r)), inject: (p) => { if (p === "verified") changed = true; } });
    await assert.rejects(svc.apply("sqlite2", (await svc.preview("sqlite2")).token), /changed while it was being copied \(aggregates\)/);
    assert.equal(await readAuthority(st(g)), undefined);
  } finally { await finish(g); }
  const h = await fixture();
  try {
    let discards = 0;
    const base = await sqlTarget(h, "dest.sqlite");
    const target: TransferTarget = { ...base, discard: async (id) => { discards += 1; await base.discard!(id); } };
    // A participant that cannot be held: the barrier is refused before any row is written.
    h.barrier.add({ name: "busy", hold: async () => { throw new Error("an attempt is running"); } });
    const svc = await service(h, [target]);
    await assert.rejects(svc.apply("sqlite2", (await svc.preview("sqlite2")).token), /busy/);
    assert.equal(discards, 0, "nothing was written, so nothing is emptied");
    const off = await service(h, [target], { enabled: async () => false });
    await assert.rejects(off.preview("sqlite2"), /switched off/); await assert.rejects(off.apply("sqlite2", "x"), /switched off/); await assert.rejects(off.rollback(), /switched off/);
  } finally { await finish(h); }
});

test("PostgreSQL addresses that differ only by a socket host are different places, and an address that cannot be read is refused (card F04e)", () => {
  assert.notEqual(postgresFingerprint("postgres:///nimble?host=/var/run/a"), postgresFingerprint("postgres:///nimble?host=/var/run/b"));
  assert.throws(() => postgresFingerprint("not a url"), /cannot be read/);
  assert.throws(() => postgresFingerprint("postgres:///nimble"), /names no server/);
});

test("an authority file or journal that cannot be read blocks a transfer instead of being guessed at; a damaged file is not overwritten (card F04e)", async () => {
  const f = await fixture();
  try {
    const target = await sqlTarget(f, "dest.sqlite");
    const svc = await service(f, [target]);
    mkdirSync(st(f), { recursive: true }); writeFileSync(join(st(f), "storage-authority.json"), "{not json");
    await assert.rejects(svc.preview("sqlite2"), /cannot be read/);
    assert.equal(readFileSync(join(st(f), "storage-authority.json"), "utf8"), "{not json");
  } finally { await finish(f); }
});

test("fingerprints keep credentials out and spell one place one way (card F04e)", async () => {
  assert.equal(postgresFingerprint("postgres://nn:secret@DB.example.com:5433/nimble", "s1"), "postgres:db.example.com:5433/nimble#s1");
  assert.equal(postgresFingerprint("postgres://nn:secret@db.example.com/nimble"), "postgres:db.example.com:5432/nimble#nimblenewt");
  assert.doesNotMatch(postgresFingerprint("postgres://nn:secret@db/x"), /secret/);
  const dir = mkdtempSync(join(tmpdir(), "nn-fp-"));
  try { assert.equal(await sqliteFingerprint(join(dir, "a", "..", "c.sqlite")), await sqliteFingerprint(join(dir, "c.sqlite"))); } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("a destination that does not read back what was written is not switched to: a changed record and a missing one are both caught (card F04e)", async () => {
  for (const [name, edit, expect] of [
    ["changed", (t: SnapshotTable, r: SnapshotRow[]) => (t === "aggregates" ? r.map((x) => (x["id"] === "task-a" ? { ...x, body: '{"title":"cafe"}' } : x)) : r), /aggregates: the records read back differ/],
    ["missing", (t: SnapshotTable, r: SnapshotRow[]) => (t === "effects" ? r.slice(1) : r), /effects: 2 records read back and 3 written/],
  ] as const) {
    const f = await fixture();
    try {
      const inner = await sqlTarget(f, "dest.sqlite");
      const target: TransferTarget = { ...inner, open: async () => { const real = await inner.open(); return new Proxy(real, { get: (o, k) => { const v = Reflect.get(o, k, o) as unknown; return k === "snapshot" ? () => doctored(o, edit).snapshot() : typeof v === "function" ? (v as (...a: unknown[]) => unknown).bind(o) : v; } }); } };
      const svc = await service(f, [target]);
      const before = await rows(f.src);
      // The preview opens the destination too; its doctored snapshot still shows an empty store, which is all the preview reads.
      const plan = await svc.preview("sqlite2");
      assert.equal(plan.ok, true, JSON.stringify(plan.findings));
      await assert.rejects(svc.apply("sqlite2", plan.token), expect, name);
      assert.deepEqual(await rows(f.src), before, name);
      assert.equal(await readAuthority(st(f)), undefined, name);
      assert.equal(f.barrier.held, false, name);
    } finally { await finish(f); }
  }
});

// ------------------------------------------------------------------------------- PostgreSQL destinations built from configuration (card F04l)

const PG_PASSWORD = "nn-test-password";
/** A PostgreSQL destination written as the configuration writes it: a secret reference; the address comes from the secret store (here a map). */
async function configuredPg(f: Fixture, entry: Record<string, unknown> = {}): Promise<{ target: TransferTarget; url: string; schema: string }> {
  const s = await server();
  const schema = `xc_${process.pid}_${counter++}_${Math.random().toString(36).slice(2, 6)}`;
  const url = s.url();
  f.cleanup.push(async () => { await dropPostgresSchema(url, schema); });
  const [target] = await transferTargetsFromConfig([{ name: "pg", kind: "postgres", url: { secret: "transfer.pg-url" }, schema, ...entry }], {
    openStorage: (path) => SqliteStorage.open({ path }), statfs: async () => { throw new Error("not used"); },
    postgres: postgresTargetDeps(async (name) => (name === "transfer.pg-url" ? url : undefined)),
  });
  return { target: target!, url, schema };
}

test("a configured PostgreSQL destination reads its free room from the server: the cap minus the size the server reports, nothing claimed without a cap (card F04l)", async () => {
  const f = await fixture();
  try {
    const cap = 400_000_000;
    const { target, url } = await configuredPg(f, { maxBytes: cap });
    const used = await postgresDatabaseBytes(url);
    assert.ok(used > 1_000_000, "the server reports a real size for a database");
    const free = await target.freeBytes!();
    assert.ok(free !== undefined && Math.abs(cap - used - free) < 2_000_000, `free ${String(free)} is the cap less the server's size ${used}`);
    const none = await configuredPg(f);
    assert.equal(await none.target.freeBytes!(), undefined, "without a cap the room is not known, and nothing is guessed");
    assert.equal(await (await configuredPg(f, { maxBytes: 1 })).target.freeBytes!(), 0, "a database already over its cap has no room");
    const svc = await service(f, [target]);
    const plan = await svc.preview("pg");
    assert.equal(plan.ok, true, JSON.stringify(plan.findings));
    assert.ok(plan.freeBytes !== undefined && plan.freeBytes <= cap && plan.freeBytes > cap - used - 2_000_000, "the plan shows the room the server's figures give");
  } finally { await finish(f); }
});

test("a configured PostgreSQL destination without room for the copy is refused by the preview and by apply; one without a cap only warns (card F04l)", async () => {
  const f = await fixture();
  try {
    const used = await postgresDatabaseBytes((await server()).url());
    const small = await configuredPg(f, { maxBytes: used + 10 });
    const svc = await service(f, [small.target]);
    const plan = await svc.preview("pg");
    assert.equal(plan.ok, false);
    assert.match(plan.findings.map((x) => x.text).join("\n"), /not enough room at the destination/);
    await assert.rejects(svc.apply("pg", plan.token), /not enough room/);
    assert.equal(f.barrier.held, false);
    const open = await configuredPg(f);
    const warn = await (await service(f, [open.target])).preview("pg");
    assert.equal(warn.ok, true);
    assert.ok(warn.findings.some((x) => x.severity === "warning" && /free room on the PostgreSQL server is not checked from here/.test(x.text)));
  } finally { await finish(f); }
});

test("a move to a configured PostgreSQL destination arrives whole; when the copy fails the schema is emptied through the server, and neither the journal nor the error carries the address or its password (card F04l)", async () => {
  const f = await fixture();
  try {
    const { target, url, schema } = await configuredPg(f);
    let armed = true;
    const svc = await service(f, [target], { pageSize: 2, inject: (p) => { if (armed && p === "copy:deliveries") throw new Error(`lost the connection to ${url} (password ${PG_PASSWORD})`); } });
    const plan = await svc.preview("pg");
    await assert.rejects(svc.apply("pg", plan.token), (e: Error) => { assert.ok(!e.message.includes(PG_PASSWORD) && !e.message.includes(url), e.message); assert.match(e.message, /lost the connection/); return true; });
    const journalText = readFileSync(join(st(f), "database-transfer-journal.json"), "utf8");
    assert.equal((JSON.parse(journalText) as { phase: string }).phase, "failed");
    assert.equal((JSON.parse(journalText) as { failure: { destinationClean: boolean } }).failure.destinationClean, true);
    for (const secret of [PG_PASSWORD, url, "postgres://"]) assert.ok(!journalText.includes(secret), `the journal does not hold ${secret.slice(0, 12)}`);
    assert.equal(await postgresSchemaExists(url, schema), false, "the schema was dropped by the target's discard");
    armed = false;
    const second = await svc.preview("pg");
    const done = await svc.apply("pg", second.token);
    assert.equal(done.restartRequired, true);
    const authority = readFileSync(join(st(f), "storage-authority.json"), "utf8");
    for (const secret of [PG_PASSWORD, url]) assert.ok(!authority.includes(secret), "the authority file does not hold the address or its password");
    assert.equal((await readAuthority(st(f)))?.active.fingerprint, target.fingerprint);
  } finally { await finish(f); }
});

test("a configured PostgreSQL destination whose schema existed before is not dropped when the copy fails: what else it holds survives and the journal says the destination is not clean (card F04l)", async () => {
  const f = await fixture();
  try {
    const { target, url, schema } = await configuredPg(f);
    // The owner prepared the schema (with something of their own in it) before naming it as a destination.
    await withClient(url, async (c) => { await c.query(`CREATE SCHEMA ${schema}`); await c.query(`CREATE SEQUENCE ${schema}.owners_own`); });
    const svc = await service(f, [target], { pageSize: 2, inject: (p) => { if (p === "copy:deliveries") throw new Error("copy failed"); } });
    const plan = await svc.preview("pg");
    assert.equal(plan.ok, true, JSON.stringify(plan.findings));
    await assert.rejects(svc.apply("pg", plan.token), /copy failed/);
    const journal = JSON.parse(readFileSync(join(st(f), "database-transfer-journal.json"), "utf8")) as { phase: string; failure: { destinationClean: boolean } };
    assert.equal(journal.phase, "failed");
    assert.equal(journal.failure.destinationClean, false, "the partial copy is still there, and the journal says so");
    assert.equal(await postgresSchemaExists(url, schema), true, "a schema the transfer did not create is not dropped");
    const kept = await withClient(url, async (c) => (await c.query("SELECT to_regclass($1)::text AS t", [`${schema}.owners_own`])).rows[0]?.t as string | null);
    assert.equal(kept, `${schema}.owners_own`, "the owner's own object in that schema survives");
  } finally { await finish(f); }
});

test("the clean-up after a failed copy into a configured PostgreSQL destination never cascades: a view elsewhere that depends on its tables, another table in the schema, someone else's state row or a taken epoch stops it, and nothing is dropped (card F04l)", async () => {
  for (const change of ["view-elsewhere", "table-inside", "foreign-holder", "epoch-taken"] as const) {
    const f = await fixture();
    try {
      const { target, url, schema } = await configuredPg(f);
      const other = `${schema}_o`;
      f.cleanup.push(async () => { await dropPostgresSchema(url, other); });
      // Done while the copy runs (after the preview's open created the schema and the copy wrote rows), then the copy fails.
      const svc = await service(f, [target], { pageSize: 2, inject: async (p) => { if (p === "copy:deliveries") { await makeForeignChange(url, schema, other, change); throw new Error("copy failed"); } } });
      const plan = await svc.preview("pg");
      assert.equal(plan.ok, true, `${change}: ${JSON.stringify(plan.findings)}`);
      await assert.rejects(svc.apply("pg", plan.token), (e: Error) => { assert.match(e.message, /copy failed/, change); assert.match(e.message, /partial copy was not removed from the destination \(.*nothing was dropped.*\); empty it by hand/, change); assert.ok(!e.message.includes(url), change); return true; });
      assert.equal((await readJournal(st(f)))?.failure?.destinationClean, false, `${change}: the journal says the destination is not clean`);
      assert.ok(await tableRows(url, schema, "operations") > 0, `${change}: nothing was dropped, the copied rows included`);
      assert.equal(await foreignChangeSurvives(url, schema, other, change), true, `${change}: what someone else made survives`);
    } finally { await finish(f); }
  }
});

test("the clean-up of a configured PostgreSQL destination drops every controller table and the schema its open created, whether or not the state row was copied, and a second run is a no-op (card F04l)", async () => {
  for (const point of ["copy:deliveries", "copied"] as const) {
    const f = await fixture();
    try {
      const { target, url, schema } = await configuredPg(f);
      let seen: string | null | undefined;
      const svc = await service(f, [target], { pageSize: 2, inject: async (p) => { if (p === point) { seen = await stateHolder(url, schema); throw new Error("copy failed"); } } });
      const plan = await svc.preview("pg");
      await assert.rejects(svc.apply("pg", plan.token), (e: Error) => !/not removed/.test(e.message));
      const journal = await readJournal(st(f));
      assert.equal(seen, point === "copied" ? `transfer-pending:${journal?.id}` : null, `${point}: the state row the clean-up found`);
      assert.equal(journal?.failure?.destinationClean, true, point);
      assert.equal(await postgresSchemaExists(url, schema), false, `${point}: the schema and everything the transfer made in it are gone`);
      await discardPostgresTransferCopy(url, schema, `transfer-pending:${journal?.id}`); // the schema is already gone: nothing to do
    } finally { await finish(f); }
  }
});

test("CONTROLLER_TABLES names exactly the tables a fresh PostgreSQL open makes, so the clean-up's list is neither short nor long (card F04l)", async () => {
  const url = (await server()).url();
  const schema = `xt_${process.pid}_${counter++}_${Math.random().toString(36).slice(2, 6)}`;
  try {
    await (await PostgresStorage.open({ connectionString: url, schema })).close();
    assert.deepEqual([...CONTROLLER_TABLES].sort(), (await schemaTables(url, schema)).sort());
  } finally { await dropPostgresSchema(url, schema); }
});

test("a second copy that commits its state row while the clean-up waits on it is not dropped: the clean-up locks the row and reads it again (card F04l)", async () => {
  const url = (await server()).url();
  const schema = `xk_${process.pid}_${counter++}_${Math.random().toString(36).slice(2, 6)}`;
  try {
    await (await PostgresStorage.open({ connectionString: url, schema })).close(); // the open's own state row: holder NULL at epoch 0, which this clean-up would drop
    const application = `nn-discard-race-${process.pid}`;
    const named = new URL(url); named.searchParams.set("application_name", application);
    // The other copy's write is uncommitted while the clean-up runs; it commits only once the clean-up is seen waiting on a lock.
    const outcome = await commitStateRowWhileWaiting(url, schema, 3, "transfer-pending:xfer-other", application,
      () => discardPostgresTransferCopy(named.toString(), schema, "transfer-pending:xfer-mine").then(() => "dropped", (error: Error) => error.message));
    assert.match(outcome, /not this transfer's/);
    assert.equal(await postgresSchemaExists(url, schema), true, "the other copy's schema is still there");
    assert.deepEqual((await schemaTables(url, schema)).sort(), [...CONTROLLER_TABLES].sort(), "every table is still there");
    assert.equal(await stateHolder(url, schema), "transfer-pending:xfer-other");
  } finally { await dropPostgresSchema(url, schema); }
});

test("a copy that fails after rows were written to a target without discard tells the owner to empty it by hand, and the journal says it is not clean (card F04l)", async () => {
  const f = await fixture();
  try {
    const inner = await sqlTarget(f, "dest.sqlite");
    const target: TransferTarget = { name: inner.name, kind: inner.kind, fingerprint: inner.fingerprint, open: inner.open, ...(inner.freeBytes === undefined ? {} : { freeBytes: inner.freeBytes }) };
    const svc = await service(f, [target], { pageSize: 2, inject: (p) => { if (p === "copy:deliveries") throw new Error("copy failed"); } });
    await assert.rejects(svc.apply("sqlite2", (await svc.preview("sqlite2")).token), (e: Error) => {
      assert.match(e.message, /copy failed/);
      assert.ok(e.message.endsWith(" The partial copy is still at the destination; empty it by hand before another transfer there."), e.message);
      return true;
    });
    assert.equal((await readJournal(st(f)))?.failure?.destinationClean, false);
  } finally { await finish(f); }
});

test("a clean-up that fails with the address in its reason reaches the owner with the address hidden by the target's redact (card F04l)", async () => {
  const f = await fixture();
  try {
    const address = "postgres://nnuser:discard-pw@db.example.com:5433/nimble";
    const inner = await sqlTarget(f, "dest.sqlite");
    const target: TransferTarget = { ...inner, discard: async () => { throw new Error(`could not empty ${address} (discard-pw)`); }, redact: (text) => text.split(address).join("[address hidden]").split("discard-pw").join("[address hidden]") };
    const svc = await service(f, [target], { pageSize: 2, inject: (p) => { if (p === "copy:deliveries") throw new Error("copy failed"); } });
    await assert.rejects(svc.apply("sqlite2", (await svc.preview("sqlite2")).token), (e: Error) => {
      assert.match(e.message, /partial copy was not removed from the destination \(could not empty \[address hidden\]/);
      assert.ok(!e.message.includes("discard-pw") && !e.message.includes("postgres://"), e.message);
      return true;
    });
    assert.equal((await readJournal(st(f)))?.failure?.destinationClean, false);
  } finally { await finish(f); }
});

test("PostgresStorage.open reports whether its own transaction created the schema (card F04l)", async () => {
  const url = (await server()).url();
  const schema = `xo_${process.pid}_${counter++}_${Math.random().toString(36).slice(2, 6)}`;
  try {
    const first = await PostgresStorage.open({ connectionString: url, schema });
    try { assert.equal(first.createdSchema, true, "the schema was absent, so this open created it"); } finally { await first.close(); }
    const second = await PostgresStorage.open({ connectionString: url, schema });
    try { assert.equal(second.createdSchema, false, "the schema was there, so this open did not create it"); } finally { await second.close(); }
  } finally { await dropPostgresSchema(url, schema); }
});

test("a schema someone else creates while a configured PostgreSQL destination is being opened is never dropped by the target (card F04l)", async () => {
  const s = await server();
  const url = s.url();
  const real = postgresTargetDeps(async (name) => (name === "transfer.pg-url" ? url : undefined));
  let before: (() => Promise<void>) | undefined;
  const build = async (schema: string): Promise<TransferTarget> => (await transferTargetsFromConfig([{ name: "pg", kind: "postgres", url: { secret: "transfer.pg-url" }, schema }], {
    openStorage: (path) => SqliteStorage.open({ path }), statfs: async () => { throw new Error("not used"); },
    postgres: { ...real, openStorage: async (u, sc) => { const hook = before; before = undefined; if (hook !== undefined) await hook(); return real.openStorage(u, sc); } },
  }))[0]!;
  const ownersSchema = (schema: string): string[] => [`CREATE SCHEMA ${schema}`, `CREATE SEQUENCE ${schema}.owners_own`];
  const survives = async (schema: string): Promise<void> => {
    const kept = await withClient(url, async (c) => (await c.query("SELECT to_regclass($1)::text AS t", [`${schema}.owners_own`])).rows[0]?.t as string | null);
    assert.equal(kept, `${schema}.owners_own`, "the owner's schema and what it holds survive");
  };
  // 1. Created by the owner after the target last looked and before the open reads pg_namespace: the open finds it there and claims nothing.
  const early = `xr_${process.pid}_${counter++}_${Math.random().toString(36).slice(2, 6)}`;
  try {
    const t = await build(early);
    before = () => withClient(url, async (c) => { for (const statement of ownersSchema(early)) await c.query(statement); });
    await (await t.open()).close();
    await assert.rejects(t.discard!("xfer-t"), /not dropped/);
    await survives(early);
  } finally { await dropPostgresSchema(url, early); }
  // 2. Created by the owner in a transaction that commits while the open waits to create it: the open's CREATE SCHEMA fails, it claims nothing, and the next open finds the owner's schema.
  const racing = `xr_${process.pid}_${counter++}_${Math.random().toString(36).slice(2, 6)}`;
  try {
    const t = await build(racing);
    // The open is blocked on the owner's uncommitted schema, then the owner commits.
    const outcome = await commitWhileWaiting(url, ownersSchema(racing), "nimblenewt-controller", `CREATE SCHEMA ${racing}`,
      () => t.open().then((store) => store.close().then(() => "opened" as const), (error: Error) => error));
    assert.ok(outcome instanceof Error, "the open that lost the race fails instead of taking the owner's schema as its own");
    await (await t.open()).close();
    await assert.rejects(t.discard!("xfer-t"), /not dropped/);
    await survives(racing);
  } finally { await dropPostgresSchema(url, racing); }
});

test("a failed copy's reason is redacted whole and then cut, so a password at the cut does not survive as a prefix (card F04l)", async () => {
  const f = await fixture();
  try {
    const inner = await sqlTarget(f, "dest.sqlite");
    const target: TransferTarget = { ...inner, redact: (text) => text.split("hunter2secret").join("[hidden]") };
    const message = `${"x".repeat(484)} password hunter2secret and more`;
    assert.ok(message.indexOf("hunter2secret") < 500 && message.indexOf("hunter2secret") + "hunter2secret".length > 500, "the password straddles the cut");
    const svc = await service(f, [target], { pageSize: 2, inject: (p) => { if (p === "copy:deliveries") throw new Error(message); } });
    const plan = await svc.preview("sqlite2");
    await assert.rejects(svc.apply("sqlite2", plan.token), (e: Error) => { assert.ok(!e.message.includes("hunt"), e.message.slice(-60)); return true; });
    const reason = (await readJournal(st(f)))?.failure?.reason ?? "";
    assert.ok(reason.length === 500 && reason.endsWith("password [hidde") && !reason.includes("hunt"), reason.slice(-60));
  } finally { await finish(f); }
});

test("what a destination's store says when the preview probes it reaches the owner with the target's address hidden (card F04l)", async () => {
  const f = await fixture();
  try {
    const address = "postgres://nnuser:probe-pw@db.example.com:5433/nimble";
    const broken = { snapshot: async () => { throw new Error(`relation missing on ${address} (probe-pw)`); }, close: async () => undefined } as unknown as ControllerStorage;
    const target: TransferTarget = { name: "pg", kind: "postgres", fingerprint: "postgres:db.example.com:5433/nimble#x", open: async () => broken, redact: (text) => text.split(address).join("[address hidden]").split("probe-pw").join("[address hidden]") };
    await assert.rejects((await service(f, [target])).preview("pg"), (e: Error) => { assert.match(e.message, /relation missing on \[address hidden\]/); assert.ok(!e.message.includes("probe-pw") && !e.message.includes("postgres://"), e.message); return true; });
  } finally { await finish(f); }
});

// ------------------------------------------------------------------------------------------ card F04m: hand-over

test("the journal and the authority file carry an integrity mark; a file changed by anything else, a stripped mark or a lost key is rejected; files an earlier version wrote are marked, not refused (card F04m)", async () => {
  const f = await fixture();
  try {
    const target = await sqlTarget(f, "dest.sqlite");
    const svc = await service(f, [target]);
    await svc.apply("sqlite2", (await svc.preview("sqlite2")).token);
    const authorityPath = join(st(f), "storage-authority.json"), journalPath = join(st(f), "database-transfer-journal.json");
    for (const path of [authorityPath, journalPath]) assert.match(JSON.parse(readFileSync(path, "utf8")).integrity, /^hmac-sha256:[0-9a-f]{64}$/, path);
    if (process.platform !== "win32") assert.equal(statSync(join(st(f), INTEGRITY_KEY_FILE)).mode & 0o777, 0o600);
    assert.equal((await readAuthority(st(f)))?.generation, 1, "an untouched file reads, and the mark is not part of what is returned");
    assert.equal("integrity" in ((await readAuthority(st(f))) as object), false);
    const original = readFileSync(authorityPath, "utf8");
    // Edited by hand: the generation is changed.
    writeFileSync(authorityPath, original.replace('"generation": 1', '"generation": 7'));
    await assert.rejects(readAuthority(st(f)), /does not match its integrity mark/);
    await assert.rejects(guardStart(st(f), { fingerprint: target.fingerprint }), /does not match its integrity mark/);
    // Pointed at the source by hand, with the old mark kept.
    const forged = JSON.parse(original); forged.active = { ...forged.previous };
    writeFileSync(authorityPath, JSON.stringify(forged));
    await assert.rejects(guardStart(st(f), { fingerprint: await sqliteFingerprint(f.srcPath) }), /integrity mark/);
    // The mark taken off.
    const stripped = JSON.parse(original); delete stripped.integrity;
    writeFileSync(authorityPath, JSON.stringify(stripped));
    await assert.rejects(readAuthority(st(f)), /has no integrity mark/);
    // Restored: reads again. The journal is judged the same way.
    writeFileSync(authorityPath, original);
    assert.equal((await readAuthority(st(f)))?.generation, 1);
    const journalText = readFileSync(journalPath, "utf8");
    writeFileSync(journalPath, journalText.replace('"phase": "switched"', '"phase": "failed"'));
    await assert.rejects(readJournal(st(f)), /does not match its integrity mark/);
    await assert.rejects(guardStart(st(f), { fingerprint: target.fingerprint }), /integrity mark/);
    writeFileSync(journalPath, journalText);
    // A lost key leaves marked files that cannot be checked.
    const keyPath = join(st(f), INTEGRITY_KEY_FILE), key = readFileSync(keyPath);
    rmSync(keyPath);
    await assert.rejects(readAuthority(st(f)), /key file is missing/);
    writeFileSync(keyPath, key);
    assert.equal((await readAuthority(st(f)))?.generation, 1);
    // Files from before the mark existed: accepted while there is no key, and marked by the first write that makes one.
    rmSync(keyPath);
    for (const path of [authorityPath, journalPath]) { const old = JSON.parse(readFileSync(path, "utf8")); delete old.integrity; writeFileSync(path, JSON.stringify(old, null, 2)); }
    assert.equal((await readAuthority(st(f)))?.generation, 1, "an unmarked file with no key is an old file");
    assert.equal((await readJournal(st(f)))?.phase, "switched");
    await guardStart(st(f), { fingerprint: target.fingerprint });
    await withStateLock(st(f), async () => { await guardStart(st(f), { fingerprint: target.fingerprint }); });
    // A write by this version makes the key and marks the other file too.
    const live = await target.open();
    try { await assertNotFenced(st(f), { fingerprint: target.fingerprint }, live); const { epoch } = await live.acquireEpoch({ holder: "c2", at: AT }); await live.applyOperation(op("restart-record", epoch, { audit: [{ type: "host.recorded", detail: {} }] })); await recordFirstStart(st(f), { fingerprint: target.fingerprint }, live); } finally { await live.close(); }
    assert.equal(existsSync(keyPath), true);
    assert.match(JSON.parse(readFileSync(authorityPath, "utf8")).integrity, /^hmac-sha256:/, "the other file is marked when the key is made");
    assert.equal((await readAuthority(st(f)))?.generation, 1);
    assert.ok((await readJournal(st(f)))?.firstStart?.digests?.["operations"]);
    // A key that is not a key is refused rather than replaced.
    writeFileSync(keyPath, "not a key");
    await assert.rejects(readAuthority(st(f)), /is not a valid key/);
  } finally { await finish(f); }
});

/** A copy left behind: the copy fails part way and the target cannot empty it (as a configured SQLite entry could not). */
async function leaveACopy(f: Fixture, path: string): Promise<{ target: TransferTarget; discards: Array<{ id: string; leftover: boolean | undefined }>; refuse: { on: boolean } }> {
  const discards: Array<{ id: string; leftover: boolean | undefined }> = [];
  const refuse = { on: true };
  const base = await sqliteTarget({ name: "sqlite2", path, open: () => SqliteStorage.open({ path }) });
  const target: TransferTarget = { ...base, discard: async (id, options) => {
    discards.push({ id, leftover: options?.leftover });
    if (refuse.on) throw new Error("the file system refused");
    for (const p of [path, `${path}-wal`, `${path}-shm`]) rmSync(p, { force: true });
  } };
  const broken = await service(f, [target], { inject: async (p) => { if (p === "copy:deliveries") throw new Error("disk went away"); } });
  await assert.rejects(broken.apply("sqlite2", (await broken.preview("sqlite2")).token), /partial copy was not removed/);
  return { target, discards, refuse };
}

test("a copy an earlier transfer left is emptied by the next one; the plan says so and the owner does not empty anything (card F04m)", async () => {
  const f = await fixture();
  try {
    const path = join(f.dir, "dest.sqlite");
    const { target, discards, refuse } = await leaveACopy(f, path);
    const first = await readJournal(st(f));
    assert.equal(first?.phase, "failed"); assert.equal(first?.failure?.destinationClean, false);
    refuse.on = false; discards.length = 0;
    const svc = await service(f, [target]);
    const plan = await svc.preview("sqlite2");
    assert.equal(plan.ok, true, JSON.stringify(plan.findings));
    assert.ok(plan.findings.some((x) => x.severity === "warning" && /left by a transfer that did not finish .*emptied first/.test(x.text)), JSON.stringify(plan.findings));
    const before = await rows(f.src);
    const done = await svc.apply("sqlite2", plan.token);
    assert.equal(done.restartRequired, true);
    assert.deepEqual(discards, [{ id: first!.id, leftover: true }], "the old transfer's copy is the one emptied");
    const dest = await target.open();
    try { const after = await rows(dest); for (const t of SNAPSHOT_TABLES) assert.equal(after[t]!.length, before[t]!.length, t); } finally { await dest.close(); }
    assert.equal((await readJournal(st(f)))?.phase, "switched");
  } finally { await finish(f); }
});

test("when the left-over copy cannot be emptied the new transfer stops, says so, and the source is as it was (card F04m)", async () => {
  const f = await fixture();
  try {
    const { target } = await leaveACopy(f, join(f.dir, "dest.sqlite"));
    const svc = await service(f, [target]);
    const before = await rows(f.src);
    await assert.rejects(svc.apply("sqlite2", (await svc.preview("sqlite2")).token), /copy left by transfer .* was not removed from the destination \(the file system refused\)/);
    assert.deepEqual(await rows(f.src), before); assert.equal(f.barrier.held, false);
    assert.equal(await readAuthority(st(f)), undefined);
  } finally { await finish(f); }
});

test("the owner's wipe of a left-over copy: a plan with a token, a wrong token refused, the copy removed, and the journal says the destination is clean; nothing is removed that is not a left-over copy (card F04m)", async () => {
  const f = await fixture();
  try {
    const path = join(f.dir, "dest.sqlite");
    const { target, refuse } = await leaveACopy(f, path);
    const svc = await service(f, [target]);
    const plan = await svc.wipePreview("sqlite2");
    assert.equal(plan.cleanable, true); assert.match(plan.findings[0]!.text, /left by a transfer that did not finish/);
    await assert.rejects(svc.wipe("sqlite2", "0".repeat(32)), /does not match the plan/);
    await assert.rejects(svc.wipe("nope", plan.token), /no database called nope/);
    refuse.on = false;
    const gone = await svc.wipe("sqlite2", plan.token);
    assert.equal(gone.target, "sqlite2"); assert.equal(existsSync(path), false);
    const j = await readJournal(st(f));
    assert.equal(j?.phase, "failed"); assert.equal(j?.failure?.destinationClean, true);
    await assert.rejects(svc.wipePreview("sqlite2"), /is empty; there is nothing to remove/);
    // The destination is a real database a controller owned: refused, whatever the journal says.
    const used = await sqlTarget(f, "used.sqlite", "used");
    const open = await used.open();
    try { await open.acquireEpoch({ holder: "c9", at: AT }); } finally { await open.close(); }
    const svc2 = await service(f, [used]);
    const refused = await svc2.wipePreview("used");
    assert.equal(refused.cleanable, false); assert.match(refused.findings[0]!.text, /a controller has already owned it/);
    await assert.rejects(svc2.wipe("used", refused.token), /already owned/);
    // The destination of a switched transfer, not yet started, is not a left-over: the authority names it.
    const live = await sqlTarget(f, "live.sqlite", "live");
    const svc3 = await service(f, [live]);
    await svc3.apply("live", (await svc3.preview("live")).token);
    const svc4 = new DatabaseTransferService({ storage: f.src, source: { kind: "sqlite", fingerprint: "sqlite:/elsewhere", name: "elsewhere" }, targets: () => [live], stateDirectory: st(f), barrier: new MaintenanceBarrier(), now: () => new Date(AT) });
    const kept = await svc4.wipePreview("live");
    assert.equal(kept.cleanable, false); assert.match(kept.findings[0]!.text, /authority file names it/);
    await assert.rejects(svc4.wipe("live", kept.token), /authority file names it/);
    assert.equal(existsSync(join(f.dir, "live.sqlite")), true);
  } finally { await finish(f); }
});

test("the same command sent again after the move is answered with what was recorded and moves nothing again, also from the controller restarted on the new database (card F04m)", async () => {
  const f = await fixture();
  try {
    const target = await sqlTarget(f, "dest.sqlite");
    let opens = 0;
    const counted: TransferTarget = { ...target, open: async () => { opens += 1; return target.open(); } };
    const svc = await service(f, [counted]);
    const plan = await svc.preview("sqlite2");
    const first = await svc.apply("sqlite2", plan.token, "cmd-move-1");
    assert.equal(first.replayed, undefined);
    const journal = await readJournal(st(f));
    assert.equal(journal?.appliedBy, "cmd-move-1");
    const seen = opens;
    const again = await svc.apply("sqlite2", plan.token, "cmd-move-1");
    assert.equal(again.replayed, true); assert.equal(again.id, first.id); assert.equal(again.to, "sqlite2"); assert.equal(again.rows, first.rows);
    assert.equal(opens, seen, "nothing was opened or copied again");
    // The controller on the new database gets the very same command (a message resent after the restart): the target is now the database in use, which a new move would refuse.
    const { svc: onNew } = await startOnDestination(f, target, { targets: () => [target] });
    const resent = await onNew.apply("sqlite2", plan.token, "cmd-move-1");
    assert.equal(resent.replayed, true); assert.equal(resent.id, first.id);
    await assert.rejects(onNew.apply("sqlite2", plan.token, "cmd-other"), /that is the database in use now/);
    // The rollback is replayed the same way.
    const back = await onNew.rollback("cmd-back-1");
    assert.equal(back.replayed, undefined);
    assert.equal((await onNew.rollback("cmd-back-1")).replayed, true);
    assert.equal((await readJournal(st(f)))?.rolledBackBy, "cmd-back-1");
  } finally { await finish(f); }
});

test("the host's restart: asked once after the answer when it opted in and the owner has not turned it off; a refusal by the host is written down; without an opt-in nothing is scheduled (card F04m)", async () => {
  const f = await fixture();
  try {
    const events: Array<{ reason: string; transferId: string; to: string }> = [];
    let enabled = true;
    const target = await sqlTarget(f, "dest.sqlite");
    const svc = await service(f, [target], { restart: { run: (e) => { events.push(e); }, delayMs: 20 }, restartEnabled: async () => enabled });
    const done = await svc.apply("sqlite2", (await svc.preview("sqlite2")).token, "cmd-1");
    assert.equal(done.restart, "scheduled");
    assert.equal(events.length, 0, "not before the answer is out");
    assert.equal((await readJournal(st(f)))?.restart?.state, "requested");
    await new Promise((r) => setTimeout(r, 120));
    assert.deepEqual(events, [{ reason: "switched", transferId: done.id, to: "sqlite2" }]);
    await new Promise((r) => setTimeout(r, 60));
    assert.equal(events.length, 1, "once");
    // The controller on the new database rolls back; the owner has turned the restart off.
    enabled = false;
    const g = await startOnDestination(f, target, { restart: { run: (e) => { events.push(e); }, delayMs: 20 }, restartEnabled: async () => enabled });
    const back = await g.svc.rollback("cmd-b");
    assert.equal(back.restart, "off");
    await new Promise((r) => setTimeout(r, 100));
    assert.equal(events.length, 1);
  } finally { await finish(f); }
  const g = await fixture();
  try {
    const target = await sqlTarget(g, "dest.sqlite");
    const refusing = await service(g, [target], { restart: { run: () => { throw new Error("no supervisor to restart me"); }, delayMs: 10 } });
    await refusing.apply("sqlite2", (await refusing.preview("sqlite2")).token);
    await new Promise((r) => setTimeout(r, 150));
    const j = await readJournal(st(g));
    assert.equal(j?.restart?.state, "failed"); assert.match(j?.restart?.reason ?? "", /no supervisor/);
    assert.equal(j?.phase, "switched", "a refused restart does not undo the move");
  } finally { await finish(g); }
  const h = await fixture();
  try {
    const target = await sqlTarget(h, "dest.sqlite");
    const plain = await service(h, [target]);
    assert.equal((await plain.apply("sqlite2", (await plain.preview("sqlite2")).token)).restart, "not-offered");
    assert.equal((await readJournal(st(h)))?.restart, undefined);
  } finally { await finish(h); }
  const i = await fixture();
  try {
    const target = await sqlTarget(i, "dest.sqlite");
    const events: unknown[] = [];
    const svc = await service(i, [target], { restart: { run: (e) => { events.push(e); }, delayMs: 50 } });
    await svc.apply("sqlite2", (await svc.preview("sqlite2")).token);
    svc.dispose();
    await new Promise((r) => setTimeout(r, 150));
    assert.equal(events.length, 0, "a controller that is closing asks for no restart");
  } finally { await finish(i); }
});

test("a write that bumps neither the audit nor the delivery counter is found by the rollback check (card F04m)", async () => {
  const f = await fixture();
  try {
    const target = await sqlTarget(f, "dest.sqlite");
    const first = await service(f, [target]);
    await first.apply("sqlite2", (await first.preview("sqlite2")).token);
    const { svc, live, epoch } = await startOnDestination(f, target);
    // A command with no audit record and no message: both counters stay where they were.
    await live.applyOperation(op("quiet-write", epoch));
    await assert.rejects(svc.rollback(), /recorded work since it started \(operations changed\)/);
    assert.equal((await readAuthority(st(f)))?.active.fingerprint, target.fingerprint, "the move stands");
    assert.equal((await readJournal(st(f)))?.phase, "switched");
  } finally { await finish(f); }
});

test("the first take of the epoch fails when something took it after the holder check read it; later takes pass (card F04m)", async () => {
  const f = await fixture();
  try {
    const seen = await f.src.currentEpoch();
    const ok = expectEpochOnFirstTake(f.src, seen);
    const taken = await ok.acquireEpoch({ holder: "start", at: AT });
    assert.equal(taken.epoch, seen + 1);
    assert.equal((await ok.acquireEpoch({ holder: "again", at: AT })).epoch, seen + 2, "only the first take is guarded");
    assert.equal(typeof ok.snapshot, "function"); await (await ok.snapshot()).close();
    // A second start got in between.
    const stale = expectEpochOnFirstTake(f.src, seen);
    await assert.rejects(stale.acquireEpoch({ holder: "late", at: AT }), /another start or a database transfer took this database while this one was starting/);
    assert.equal(expectEpochOnFirstTake(f.src, undefined), f.src);
  } finally { await finish(f); }
});

test("a PostgreSQL copy left by a controller that has since restarted is emptied by the next transfer and by the owner's wipe, though this process did not create the schema (card F04m)", async () => {
  const f = await fixture();
  try {
    // First run: the copy fails part way (after rows were written) and the schema is left because the drop is refused.
    const first = await configuredPg(f);
    const broken = { ...first.target, discard: async () => { throw new Error("refused for the test"); } };
    const svcA = await service(f, [broken], { inject: async (p) => { if (p === "copy:deliveries") throw new Error("the connection dropped"); } });
    await assert.rejects(svcA.apply("pg", (await svcA.preview("pg")).token), /partial copy was not removed/);
    assert.equal(await postgresSchemaExists(first.url, first.schema), true);
    // A new process: the target is built again from the same entry; its open did not create the schema.
    const [again] = await transferTargetsFromConfig([{ name: "pg", kind: "postgres", url: { secret: "transfer.pg-url" }, schema: first.schema }], {
      openStorage: (path) => SqliteStorage.open({ path }), statfs: async () => { throw new Error("not used"); },
      postgres: postgresTargetDeps(async (name) => (name === "transfer.pg-url" ? first.url : undefined)),
    });
    const svcB = await service(f, [again!]);
    const wipePlan = await svcB.wipePreview("pg");
    assert.equal(wipePlan.cleanable, true, JSON.stringify(wipePlan.findings));
    // The owner's wipe removes it.
    await svcB.wipe("pg", wipePlan.token);
    assert.equal(await postgresSchemaExists(first.url, first.schema), false, "the schema made for the copy is gone");
    assert.equal((await readJournal(st(f)))?.failure?.destinationClean, true);
    // And the next move simply works.
    const plan = await svcB.preview("pg");
    assert.equal(plan.ok, true, JSON.stringify(plan.findings));
    await svcB.apply("pg", plan.token);
    assert.equal((await readAuthority(st(f)))?.active.kind, "postgres");
  } finally { await finish(f); }
});
