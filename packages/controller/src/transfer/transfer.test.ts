import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { MaintenanceBarrier } from "../backup/barrier.js";
import { PostgresStorage } from "../storage/postgres/index.js";
import { startTestServer, withClient, type TestServer } from "../storage/postgres/testing/server.js";
import { SqliteStorage } from "../storage/sqlite/index.js";
import { SNAPSHOT_TABLES, type SnapshotRow, type SnapshotTable, type StorageSnapshot } from "../storage/snapshot.js";
import type { ControllerStorage, OperationInput } from "../storage/types.js";
import { DatabaseTransferService, assertStorageAuthority, postgresFingerprint, readAuthority, readJournal, resolveAtStart, sqliteFingerprint, sqliteTarget, type TransferOptions, type TransferPoint, type TransferTarget } from "./index.js";

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
  new DatabaseTransferService({ storage: f.src, source: { kind: "sqlite", fingerprint: await sqliteFingerprint(f.srcPath), name: "source" }, targets: () => targets, dataDirectory: f.dir, barrier: f.barrier, now: () => new Date(AT), ...over });

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
    const authority = await readAuthority(f.dir);
    assert.equal(authority?.active.fingerprint, target.fingerprint); assert.equal(authority?.generation, 1);
    assert.equal((await readJournal(f.dir))?.phase, "switched");
    // Only the destination may be started on now.
    await assert.rejects(assertStorageAuthority(f.dir, { fingerprint: await sqliteFingerprint(f.srcPath) }), /moved to pg/);
    await assertStorageAuthority(f.dir, { fingerprint: target.fingerprint });
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
      const reverse = new DatabaseTransferService({ storage: live, source: { kind: "postgres", fingerprint: pg.fingerprint, name: "pg" }, targets: () => [back], dataDirectory: f.dir, barrier, now: () => new Date(AT) });
      const plan = await reverse.preview("back");
      assert.equal(plan.direction, "postgres to sqlite"); assert.equal(plan.ok, true, JSON.stringify(plan.findings));
      assert.ok(plan.freeBytes !== undefined && plan.freeBytes > 0, "the SQLite side reports free room");
      await reverse.apply("back", plan.token);
      const dest = await back.open();
      try { assert.equal((await dest.getAggregate({ kind: "task", id: "task-b" }))?.body["title"], "later"); assert.equal((await dest.getAggregate({ kind: "task", id: "task-a" }))?.body["title"], "café"); assert.equal((await dest.getEffect("eff-3"))?.status, "uncertain"); } finally { await dest.close(); }
      assert.equal((await readAuthority(f.dir))?.generation, 2);
      assert.equal((await readAuthority(f.dir))?.active.fingerprint, back.fingerprint);
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
      assert.equal(await readAuthority(f.dir), undefined, point);
      const journal = await readJournal(f.dir);
      assert.equal(journal?.phase, "failed", point); assert.match(journal?.failure?.reason ?? "", /injected/);
      assert.equal(journal?.failure?.destinationClean, true);
      // The source still accepts writes with its own epoch.
      await f.src.applyOperation(op(`after-${point}`, f.epoch));
      armed = false;
      const second = await svc.preview("sqlite2");
      assert.equal(second.ok, true, `${point}: ${JSON.stringify(second.findings)}`);
      // The retry is refused only because the source recorded something since (the new operation), which is correct to run again from a new plan.
      await svc.apply("sqlite2", second.token);
      assert.equal((await readJournal(f.dir))?.phase, "switched", point);
    } finally { await finish(f); }
  }
});

test("a failure after the fence is settled at the next start: on the destination it finishes, on the source it is abandoned (card F04e)", async () => {
  for (const [point, configured, resolved] of [["fenced", "destination", "finished"], ["fenced", "source", "abandoned"], ["authority-written", "source", "finished"], ["authority-written", "destination", "finished"]] as const) {
    const f = await fixture();
    try {
      const target = await sqlTarget(f, "dest.sqlite");
      const svc = await service(f, [target], { inject: (p) => { if (p === point) throw new Error("boom"); } });
      const plan = await svc.preview("sqlite2");
      await assert.rejects(svc.apply("sqlite2", plan.token), /fenced/);
      assert.equal(f.barrier.held, true, "fenced and not switched: the controller stays down");
      assert.equal((await readJournal(f.dir))?.phase, "fencing");
      const place = configured === "source" ? { fingerprint: await sqliteFingerprint(f.srcPath) } : { fingerprint: target.fingerprint };
      const settled = await resolveAtStart(f.dir, place, () => new Date(AT));
      assert.equal(settled.resolved, resolved, `${point} on ${configured}`);
      if (resolved === "finished") { assert.equal((await readAuthority(f.dir))?.active.fingerprint, target.fingerprint); assert.equal((await readJournal(f.dir))?.phase, "switched"); await assert.rejects(assertStorageAuthority(f.dir, { fingerprint: await sqliteFingerprint(f.srcPath) }), /will not start/); }
      else { assert.equal(await readAuthority(f.dir), undefined); assert.equal((await readJournal(f.dir))?.phase, "abandoned"); await assertStorageAuthority(f.dir, place); }
      assert.deepEqual(await resolveAtStart(f.dir, place), {}, "settled once");
    } finally { await finish(f); }
  }
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
      ["a missing checkpoint", (_t, r) => r, /checkpoint of recovery point rp-1 is not in the conversation store/, { references: { checkpoints: async (p) => p.map((x) => x.id) } }],
    ];
    for (const [name, edit, expect, extra] of cases) {
      const svc = await service(f, [target], { storage: doctored(f.src, edit), ...(extra ?? {}) });
      const plan = await svc.preview("sqlite2");
      assert.equal(plan.ok, false, name);
      assert.match(plan.findings.map((x) => x.text).join("|"), expect, name);
      await assert.rejects(svc.apply("sqlite2", plan.token), /transfer is not started/, name);
      assert.equal(f.barrier.held, false, name);
      assert.equal(await readJournal(f.dir), undefined, `${name}: nothing was started`);
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
    assert.equal(existsSync(join(f.dir, "database-transfer-journal.json")), false);
  } finally { await finish(f); }
});

test("a source that records something while it is copied is not switched (card F04e)", async () => {
  const f = await fixture();
  try {
    const target = await sqlTarget(f, "dest.sqlite");
    const svc = await service(f, [target], { inject: async (p) => { if (p === "copied") await f.src.applyOperation(op("sneaky", f.epoch, { audit: [{ type: "x", detail: {} }] })); } });
    await assert.rejects(svc.apply("sqlite2", (await svc.preview("sqlite2")).token), /recorded something while it was being copied/);
    assert.equal(await readAuthority(f.dir), undefined); assert.equal(f.barrier.held, false);
    assert.equal((await readJournal(f.dir))?.phase, "failed");
  } finally { await finish(f); }
});

test("rollback puts the source back while the destination has recorded nothing, and refuses once it has (card F04e)", async () => {
  const f = await fixture();
  try {
    const target = await sqlTarget(f, "dest.sqlite");
    const svc = await service(f, [target]);
    await svc.apply("sqlite2", (await svc.preview("sqlite2")).token);
    const back = await svc.rollback();
    assert.equal(back.restartRequired, true);
    const authority = await readAuthority(f.dir);
    assert.equal(authority?.active.fingerprint, await sqliteFingerprint(f.srcPath)); assert.equal(authority?.generation, 2);
    assert.equal((await readJournal(f.dir))?.phase, "rolled-back");
    await assertStorageAuthority(f.dir, { fingerprint: await sqliteFingerprint(f.srcPath) });
    await assert.rejects(assertStorageAuthority(f.dir, { fingerprint: target.fingerprint }), /will not start/);
    // The destination was fenced by the rollback: a controller that starts on it takes the next epoch, but the authority file refuses that start anyway.
    await assert.rejects(svc.rollback(), /no switched transfer/);
  } finally { await finish(f); }
  const g = await fixture();
  try {
    const target = await sqlTarget(g, "dest.sqlite");
    const svc = await service(g, [target]);
    await svc.apply("sqlite2", (await svc.preview("sqlite2")).token);
    // The new database is started on and records a new effect.
    const live = await target.open();
    try {
      const { epoch } = await live.acquireEpoch({ holder: "c2", at: AT });
      await live.applyOperation(op("new-work", epoch, { effects: [{ effectId: "eff-new", target: "repo:z", inputDigest: "e".repeat(64) }], audit: [{ type: "x", detail: {} }] }));
    } finally { await live.close(); }
    await assert.rejects(svc.rollback(), /recorded work since the switch .*reverse transfer/);
    assert.equal((await readAuthority(g.dir))?.active.fingerprint, target.fingerprint, "authority did not move");
    assert.equal((await readJournal(g.dir))?.phase, "switched");
  } finally { await finish(g); }
});

test("an authority file or journal that cannot be read blocks a transfer instead of being guessed at; a damaged file is not overwritten (card F04e)", async () => {
  const f = await fixture();
  try {
    const target = await sqlTarget(f, "dest.sqlite");
    const svc = await service(f, [target]);
    writeFileSync(join(f.dir, "storage-authority.json"), "{not json");
    await assert.rejects(svc.preview("sqlite2"), /cannot be read/);
    assert.equal(readFileSync(join(f.dir, "storage-authority.json"), "utf8"), "{not json");
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
      assert.equal(await readAuthority(f.dir), undefined, name);
      assert.equal(f.barrier.held, false, name);
    } finally { await finish(f); }
  }
});
