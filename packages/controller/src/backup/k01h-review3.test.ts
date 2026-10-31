import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { hostname, tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { DomainError } from "../domain/errors.js";
import { SqliteStorage } from "../storage/index.js";
import { BackupService, MaintenanceBarrier, StagedRestore, acquireDataLock, acquireDataLocks, applyPendingRestore, keepDataLocks, createBackup } from "./index.js";
import { applyAndCrashAfter } from "./k01h-crash.js";
import { LOCK_FILE, DataLockBusy, lockIsLive, refreshMsFor } from "./data-lock.js";
import { runBackupCli } from "./cli.js";

// Re-review fixes of card K01h (the third round): each test is written to fail without its fix.
const AT = "2026-10-31T10:00:00.000Z";
const tmp = (): string => mkdtempSync(join(tmpdir(), "nn-k01hr3-"));
const wait = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
const until = async (test: () => boolean | Promise<boolean>, ms = 4000): Promise<boolean> => { const end = Date.now() + ms; while (Date.now() < end) { if (await test()) return true; await wait(20); } return test(); };
const EMPTY = { outbox: [], effects: [], timers: [], cancelTimers: [], completeDeliveries: [], completeTimers: [], settleEffects: [] };
const lockOf = (dir: string): { nonce: string; refreshMs: number; staleMinutes: unknown } => JSON.parse(readFileSync(join(dir, LOCK_FILE), "utf8")) as never;

test("finding 1: a lock written by ANOTHER host is judged by its age alone, whatever boot id and pid it names", async () => {
  const nowMs = Date.parse("2026-10-31T12:00:00.000Z");
  const me = { pid: 100, hostname: () => "h1", bootId: () => "boot-A", startOf: () => undefined, alive: () => false, now: () => new Date(nowMs), staleMinutes: 10 };
  const foreign = { pid: 7, host: "nfs-client-2", nonce: "n", boot: "boot-OTHER-MACHINE", start: "s9" };
  assert.equal(lockIsLive(foreign, nowMs - 60_000, me), true, "a different boot of ANOTHER machine says nothing");
  assert.equal(lockIsLive(foreign, nowMs - 11 * 60_000, me), false, "not refreshed for longer than the stale time");
  // The same host's lock of a different boot is stale at once.
  assert.equal(lockIsLive({ ...foreign, host: "h1" }, nowMs, { ...me, alive: () => true }), false);
  // And a start really refuses it.
  const d = tmp();
  try {
    writeFileSync(join(d, LOCK_FILE), `${JSON.stringify({ ...foreign, at: AT })}\n`);
    await assert.rejects(acquireDataLock(d, { ...me, now: () => new Date() }), (e: unknown) => e instanceof DataLockBusy);
  } finally { rmSync(d, { recursive: true, force: true }); }
});

test("findings 4, 6: the staleness margin is at least twice the refresh period plus a skew allowance; where the start time is unknown the heartbeat decides (injected clock)", () => {
  const nowMs = Date.parse("2026-10-31T12:00:00.000Z");
  const me = { pid: 100, hostname: () => "h1", bootId: () => "boot-A", startOf: () => undefined, alive: () => true, now: () => new Date(nowMs), staleMinutes: 10 };
  const holder = { pid: 200, host: "h1", nonce: "n", boot: "boot-A", start: "s1", staleMinutes: 10 };
  assert.equal(lockIsLive(holder, nowMs - 30_000, me), true, "refreshed a moment ago, pid exists");
  assert.equal(lockIsLive(holder, nowMs - 5 * 60_000, me), false, "a pid that exists but a lock nobody refreshed for 5 minutes: the pid was reused (Windows, macOS)");
  // A tiny stale setting does not make a margin smaller than two refresh periods plus the skew.
  const foreign = { pid: 1, host: "other", nonce: "n", staleMinutes: 0.05 };
  assert.ok(refreshMsFor(0.05) >= 1000);
  assert.equal(lockIsLive(foreign, nowMs - 20_000, me), true, "3 seconds of stale time, but 2 x refresh + skew is more");
  assert.equal(lockIsLive(foreign, nowMs - 120_000, me), false);
});

test("finding 4: setStaleMinutes re-arms the refresh timer; a refresh that cannot be made is told once", async () => {
  const d = tmp();
  try {
    const lock = await acquireDataLock(d); // default 10 minutes: refreshed every minute
    await lock.setStaleMinutes(0.02); // refreshed every second
    assert.equal(lockOf(d).refreshMs, 1000);
    const old = new Date(Date.now() - 3_600_000);
    utimesSync(join(d, LOCK_FILE), old, old);
    assert.equal(await until(() => Date.now() - statSync(join(d, LOCK_FILE)).mtimeMs < 60_000, 3500), true, "the new period is in force");
    await lock.release();
    // The lock file is removed under a holder: it is told, once, not swallowed.
    const told: string[] = [];
    const held = await acquireDataLock(d, { heartbeatMs: 20, warn: (m) => told.push(m) });
    rmSync(join(d, LOCK_FILE));
    assert.equal(await until(() => told.length > 0, 2000), true);
    await wait(200);
    assert.equal(told.length, 1, "once per episode");
    assert.equal(await held.isHeld(), false);
    await held.release();
  } finally { rmSync(d, { recursive: true, force: true }); }
});

test("finding 2: a start that found a live holder goes on without the lock, says so once, and takes the lock when the holder lets go; a torn lock file is not tolerated", async () => {
  const d = tmp();
  try {
    const holder = await acquireDataLock(d, { heartbeatMs: 30 });
    const told: string[] = [];
    const keeper = await keepDataLocks([d], { heartbeatMs: 30, warn: (m) => told.push(m) }, { tolerateBusy: () => true });
    assert.equal(await keeper.isHeld(), false);
    assert.equal(told.length, 1);
    assert.match(told[0]!, /WITHOUT the data directory lock/);
    await assert.rejects(keeper.require(), /does not hold the data directory lock/);
    await holder.release();
    assert.equal(await until(() => keeper.isHeld()), true, "retaken after the holder let go");
    assert.equal(lockOf(d).nonce !== undefined, true);
    assert.match(told[told.length - 1]!, /now holds/);
    await keeper.require();
    // The lock is lost (the file removed): it is retaken.
    rmSync(join(d, LOCK_FILE));
    assert.equal(await until(async () => existsSync(join(d, LOCK_FILE)) && await keeper.isHeld()), true);
    await keeper.release();
    assert.equal(existsSync(join(d, LOCK_FILE)), false);
    // A lock file that cannot be read is an error, tolerated or not.
    writeFileSync(join(d, LOCK_FILE), "{ torn");
    await assert.rejects(keepDataLocks([d], { heartbeatMs: 30 }, { tolerateBusy: () => true }), (e: unknown) => e instanceof DomainError && !(e instanceof DataLockBusy) && /cannot be read/.test(e.message));
    // And a refused tolerance is an error for a live holder too.
    rmSync(join(d, LOCK_FILE));
    const live = await acquireDataLock(d);
    await assert.rejects(keepDataLocks([d], {}, { tolerateBusy: () => false }), (e: unknown) => e instanceof DataLockBusy);
    await live.release();
  } finally { rmSync(d, { recursive: true, force: true }); }
});

test("finding 2: preparing a restore requires the lock: it is taken at that moment when it can be, and the restore is refused (nothing staged) when it cannot", async () => {
  const d = tmp();
  try {
    const data = join(d, "data"); mkdirSync(data);
    const sqlite = join(data, "c.sqlite");
    const storage = await SqliteStorage.open({ path: sqlite });
    const { epoch } = await storage.acquireEpoch({ holder: "c1", at: AT });
    await storage.applyOperation({ operationId: "op-1", epoch, actor: "owner:rob", correlationId: "co-1", at: AT, changes: [{ type: "create", ref: { kind: "task", id: "task-1" }, body: { title: "x" } }], audit: [{ type: "task.created", detail: {} }], ...EMPTY } as never);
    let bt = Date.parse(AT);
    const backups = new BackupService(storage, { root: join(d, "b"), version: "t", now: () => new Date(bt += 1000) });
    const made = await backups.backUpNow("manual");
    const barrier = new MaintenanceBarrier();
    barrier.add({ name: "backups", hold: async () => backups.hold() });
    const holder = await acquireDataLock(data, { heartbeatMs: 30 });
    const keeper = await keepDataLocks([data], { heartbeatMs: 3_600_000 }, { tolerateBusy: () => true });
    const sr = new StagedRestore({ backups, root: join(d, "b"), barrier, sqlitePath: sqlite, dataDirectory: data, storage, lock: keeper });
    const plan = await sr.preview(made.manifest.name);
    await assert.rejects(sr.apply(plan.name, plan.token), /does not hold the data directory lock/);
    assert.equal(existsSync(join(data, "pending-restore.json")), false);
    assert.equal(barrier.state().held, false);
    await holder.release();
    // The keeper's own timer is slow here: apply takes the lock itself.
    const done = await sr.apply(plan.name, plan.token);
    assert.equal(done.pending.name, made.manifest.name);
    assert.equal(await keeper.isHeld(), true);
    await keeper.release();
    await storage.close();
  } finally { rmSync(d, { recursive: true, force: true }); }
});

test("finding 3: folders that are one place by a link are one lock (acquireDataLocks, and the offline restore command)", async (t) => {
  const d = tmp();
  try {
    const real = join(d, "real"); mkdirSync(real);
    const via = join(d, "via");
    try { symlinkSync(real, via, "dir"); } catch (e) { t.skip(`cannot create a link here: ${(e as NodeJS.ErrnoException).code}`); return; }
    const both = await acquireDataLocks([via, real]);
    await both.release();
    const one = await acquireDataLocks([join(via, "."), real, join(real, "..", "real")]);
    assert.equal(one.path, join(statRealpath(real), LOCK_FILE));
    await one.release();
    assert.equal(existsSync(join(real, LOCK_FILE)), false);
    // The offline restore: the new database is in a link to the folder the conversation stores go to.
    const src = await SqliteStorage.open({ path: join(d, "src.sqlite") });
    const { epoch } = await src.acquireEpoch({ holder: "c1", at: AT });
    await src.applyOperation({ operationId: "op-1", epoch, actor: "owner:rob", correlationId: "co-1", at: AT, changes: [{ type: "create", ref: { kind: "task", id: "task-a" }, body: { title: "x" } }], audit: [], ...EMPTY } as never);
    const { path } = await createBackup(src, { root: join(d, "b"), kind: "manual", version: "t", now: () => new Date(AT) });
    await src.close();
    const out: string[] = [];
    assert.equal(await runBackupCli(["restore", path, "--sqlite", join(via, "new.sqlite"), "--pi-state", join(real, "pi")], (l) => { out.push(l); }), 0, out.join("\n"));
  } finally { rmSync(d, { recursive: true, force: true }); }
});
import { realpathSync } from "node:fs";
const statRealpath = (p: string): string => realpathSync.native(p);

test("finding 9: a file system whose hard link answers EISDIR or EINVAL gets the exclusive-create fallback (lock and key file); an unrelated error is still an error", async () => {
  for (const code of ["EISDIR", "EINVAL"]) {
    const d = tmp();
    try {
      const failing = async (): Promise<void> => { throw Object.assign(new Error("no links"), { code }); };
      const lock = await acquireDataLock(d, { link: failing });
      assert.equal(existsSync(join(d, LOCK_FILE)), true, code);
      await lock.release();
    } finally { rmSync(d, { recursive: true, force: true }); }
  }
  const d = tmp();
  try {
    await assert.rejects(acquireDataLock(d, { link: async () => { throw Object.assign(new Error("denied"), { code: "EACCES" }); } }), /denied/);
  } finally { rmSync(d, { recursive: true, force: true }); }
});

async function stagedRig() {
  const d = tmp();
  const data = join(d, "data"); mkdirSync(data);
  const live = join(d, "live"); mkdirSync(join(live, "att-1"), { recursive: true });
  writeFileSync(join(live, "att-1", "history.jsonl"), '{"id":1}\n');
  const sqlite = join(data, "c.sqlite");
  const storage = await SqliteStorage.open({ path: sqlite });
  const { epoch } = await storage.acquireEpoch({ holder: "c1", at: AT });
  let n = 0;
  const op = async (audits = 1): Promise<void> => { n += 1; await storage.applyOperation({ operationId: `op-${n}`, epoch, actor: "owner:rob", correlationId: `co-${n}`, at: AT, changes: [{ type: "create", ref: { kind: "task", id: `task-${n}` }, body: { title: `t${n}` } }], audit: Array.from({ length: audits }, () => ({ type: "task.created", detail: {} })), ...EMPTY } as never); };
  await op();
  let bt = Date.parse(AT);
  const backups = new BackupService(storage, { root: join(d, "b"), version: "t", now: () => new Date(bt += 1000), piState: { list: async () => [{ id: "att-1", dir: join(live, "att-1") }] } });
  const made = await backups.backUpNow("manual");
  const barrier = new MaintenanceBarrier();
  barrier.add({ name: "backups", hold: async () => backups.hold() });
  const piFinal = (id: string): string => join(live, id);
  const restore = (extra: Partial<ConstructorParameters<typeof StagedRestore>[0]> = {}): StagedRestore => new StagedRestore({ backups, root: join(d, "b"), barrier, sqlitePath: sqlite, dataDirectory: data, storage, piFinal, now: () => new Date("2026-10-31T11:00:00.000Z"), ...extra });
  return { d, data, live, sqlite, storage, made, restore, op, piFinal };
}

test("finding 5: a crash after the swap was recorded done, before the marker was removed, or between the marker and the journal, only finishes the clean-up; the swap is not undone", async () => {
  for (const at of ["before-marker-removal", "before-journal-removal"] as const) {
    const r = await stagedRig();
    try {
      await r.op();
      const sr = r.restore();
      const plan = await sr.preview(r.made.manifest.name);
      await sr.apply(plan.name, plan.token);
      await r.storage.close();
      assert.equal(applyAndCrashAfter(r.data, r.sqlite, r.live, at), 3);
      assert.equal(existsSync(join(r.data, "restore-journal.json")), true, at);
      assert.equal(existsSync(join(r.data, "pending-restore.json")), at === "before-marker-removal");
      const out: string[] = [];
      await applyPendingRestore(r.data, r.sqlite, (l) => out.push(l), { piFinal: r.piFinal });
      assert.match(out.join("\n"), /was applied/, at);
      assert.equal(existsSync(join(r.data, "restore-journal.json")), false);
      assert.equal(existsSync(join(r.data, "pending-restore.json")), false);
      const s = await SqliteStorage.open({ path: r.sqlite });
      try { assert.equal(await s.getAggregate({ kind: "task", id: "task-2" }), undefined, "the restored database stayed in place (not rolled back)"); } finally { await s.close(); }
    } finally { rmSync(r.d, { recursive: true, force: true }); }
  }
});

test("finding 7: a swap that already happened is cleaned up even when the marker no longer authenticates", async () => {
  const r = await stagedRig();
  try {
    const sr = r.restore();
    const plan = await sr.preview(r.made.manifest.name);
    await sr.apply(plan.name, plan.token);
    await r.storage.close();
    assert.equal(applyAndCrashAfter(r.data, r.sqlite, r.live, "before-marker-removal"), 3);
    writeFileSync(join(r.data, "pending-restore.json"), "{ not json");
    await applyPendingRestore(r.data, r.sqlite, undefined, { piFinal: r.piFinal });
    assert.equal(existsSync(join(r.data, "restore-journal.json")), false);
    assert.equal(existsSync(join(r.data, "pending-restore.json")), false);
  } finally { rmSync(r.d, { recursive: true, force: true }); }
});

test("finding 5: a crash mid-swap is resumed from the journal's own paths, even when the marker's places would no longer be accepted (journal first)", async () => {
  const r = await stagedRig();
  try {
    const sr = r.restore();
    const plan = await sr.preview(r.made.manifest.name);
    await sr.apply(plan.name, plan.token);
    await r.storage.close();
    assert.equal(applyAndCrashAfter(r.data, r.sqlite, r.live, 1), 3);
    // The conversation stores are now looked for elsewhere: the marker alone would be refused ("not where this installation keeps"), the journal knows its own paths.
    const elsewhere = (id: string): string => join(r.d, "elsewhere", id);
    await assert.rejects(r.restore({ piFinal: elsewhere }).status().then((s) => { if (s.markerProblem !== undefined) throw new Error(s.markerProblem); }), /not where this installation keeps/);
    assert.equal(await applyPendingRestore(r.data, r.sqlite, undefined, { piFinal: elsewhere }), r.made.manifest.name);
    assert.equal(readFileSync(join(r.live, "att-1", "history.jsonl"), "utf8"), '{"id":1}\n');
  } finally { rmSync(r.d, { recursive: true, force: true }); }
});

test("finding 7: cancel does not report a restore cancelled while the journal of a half-done swap cannot be checked; the journal is kept", async () => {
  const r = await stagedRig();
  try {
    const sr = r.restore();
    const plan = await sr.preview(r.made.manifest.name);
    await sr.apply(plan.name, plan.token);
    await r.storage.close();
    assert.equal(applyAndCrashAfter(r.data, r.sqlite, r.live, 1), 3);
    writeFileSync(join(r.data, "restore-journal.json"), "{ torn");
    await assert.rejects(r.restore().cancel(), /was not cancelled/);
    assert.equal(existsSync(join(r.data, "restore-journal.json")), true);
    assert.equal(existsSync(join(r.data, "pending-restore.json")), true);
  } finally { rmSync(r.d, { recursive: true, force: true }); }
});

test("finding 9: the key file is made by the exclusive-create fallback when the link answers EISDIR or EINVAL", async () => {
  for (const code of ["EISDIR", "EINVAL"]) {
    const r = await stagedRig();
    try {
      const sr = r.restore({ link: async () => { throw Object.assign(new Error("no links"), { code }); } });
      const plan = await sr.preview(r.made.manifest.name);
      await sr.apply(plan.name, plan.token);
      assert.match(readFileSync(join(r.data, ".nn-restore.key"), "utf8"), /^[0-9a-f]{64}\s*$/, code);
    } finally { await r.storage.close().catch(() => undefined); rmSync(r.d, { recursive: true, force: true }); }
  }
});

test("finding 8: the default margin tolerates a busy installation (200 audit rows); changes written while the backup is restored are counted too", async () => {
  const r = await stagedRig();
  try {
    const sr = r.restore();
    const plan = await sr.preview(r.made.manifest.name);
    await r.op(30); // more than the old default of 20
    await sr.apply(plan.name, plan.token);
    await sr.cancel();
    // Rows written during the restore itself (here, while the deletions are read) are checked before the marker is written.
    let first = true;
    const busy = r.restore({ changeMargin: async () => 2, deletions: async () => { if (first) { first = false; await r.op(10); } return []; } });
    const p2 = await busy.preview(r.made.manifest.name);
    await assert.rejects(busy.apply(p2.name, p2.token), /new preview/);
    assert.equal(existsSync(join(r.data, "pending-restore.json")), false);
    assert.equal(first, false, "the rows were written during the restore");
  } finally { await r.storage.close().catch(() => undefined); rmSync(r.d, { recursive: true, force: true }); }
});

void hostname;
