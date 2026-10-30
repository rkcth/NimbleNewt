import assert from "node:assert/strict";
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync, existsSync, mkdirSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { FileBlobStore } from "../artifacts/index.js";
import { chmodSync } from "node:fs";
import { backends, stopServer } from "../domain/testing/backends.js";
import { MemoryStorage, type ControllerStorage } from "../storage/index.js";
import { BackupService, RestoreRefused, chooseKept, createBackup, listBackups, pruneBackups, restoreBackup, verifyBackup, type BackupInfo, type BackupKind } from "./index.js";

after(stopServer);

const AT = "2026-10-29T10:00:00.000Z";
const tmp = (): string => mkdtempSync(join(tmpdir(), "nn-backup-"));

async function populate(storage: ControllerStorage): Promise<void> {
  const { epoch } = await storage.acquireEpoch({ holder: "c1", at: AT });
  await storage.applyOperation({ operationId: "op-1", epoch, actor: "owner:rob", correlationId: "co-1", at: AT, changes: [{ type: "create", ref: { kind: "task", id: "task-a" }, body: { title: "café" } }],
    audit: [{ type: "task.created", detail: {} }], outbox: [{ deliveryId: "dlv-1", destination: "inbox", priority: 5, aggregate: { kind: "task", id: "task-a" }, payload: {} }],
    effects: [{ effectId: "eff-1", target: "repo:main", inputDigest: "a".repeat(64) }, { effectId: "eff-2", target: "repo:other", inputDigest: "b".repeat(64) }], timers: [{ timerId: "tm-1", dueAt: "2026-10-30T10:00:00.000Z", payload: {} }], cancelTimers: [], completeDeliveries: [], completeTimers: [], settleEffects: [] });
  await storage.applyOperation({ operationId: "op-2", epoch, actor: "owner:rob", correlationId: "co-2", at: AT, changes: [], audit: [], outbox: [], effects: [], timers: [], cancelTimers: [], completeDeliveries: [], completeTimers: [], settleEffects: [{ effectId: "eff-2", outcome: "confirmed" }] } as never);
}

for (const backend of backends) {
  test(`${backend.name}: a backup is a verified folder, and restores into a new empty store with intended effects left uncertain (card K01)`, async () => {
    const a = await backend.open(); const b = await backend.open(); const root = tmp();
    try {
      await populate(a.storage);
      const { path, manifest } = await createBackup(a.storage, { root, kind: "manual", version: "0.0.0-test", now: () => new Date(AT) });
      assert.equal(manifest.name, "backup-20261029T100000Z-manual");
      assert.equal(manifest.epoch, 1);
      assert.deepEqual(readdirSync(root), ["backup-20261029T100000Z-manual"], "no partial folder is left");
      assert.deepEqual(manifest.files.map((f) => [f.table, f.rows]), [["operations", 2], ["aggregates", 1], ["audit", 2], ["deliveries", 1], ["effects", 2], ["timers", 1], ["state", 1]]);
      assert.equal((await verifyBackup(path)).ok, true);
      assert.equal((await listBackups(root)).length, 1);

      const restored = await restoreBackup(path, b.storage);
      assert.equal(restored.rows, 10);
      assert.equal(restored.effectsMarkedUncertain, 1, "eff-1 was only intended");
      assert.equal(restored.deliveriesToResend, 1, "dlv-1 had not been delivered");
      assert.equal((await b.storage.getEffect("eff-1"))?.status, "uncertain");
      assert.equal((await b.storage.getEffect("eff-2"))?.status, "confirmed");
      assert.equal((await b.storage.getAggregate({ kind: "task", id: "task-a" }))?.body["title"], "café");
      assert.equal(await b.storage.currentEpoch(), 1);
      // A store that has been owned is not restored into, and nothing was written by the refusal.
      await assert.rejects(restoreBackup(path, a.storage), (e: unknown) => e instanceof RestoreRefused && /not empty/.test(e.message));
    } finally { await a.close(); await b.close(); rmSync(root, { recursive: true, force: true }); }
  });
}

test("a backup that was changed, truncated or never finished cannot be restored", async () => {
  const store = new MemoryStorage(); const target = new MemoryStorage(); const root = tmp();
  try {
    await populate(store);
    const { path } = await createBackup(store, { root, kind: "manual", version: "t", now: () => new Date(AT) });
    const file = join(path, "aggregates.jsonl");
    const original = readFileSync(file, "utf8");
    writeFileSync(file, original.replace("caf", "cof"));
    const bad = await verifyBackup(path);
    assert.equal(bad.ok, false);
    assert.match(bad.problems.join(";"), /aggregates: the contents do not match/);
    await assert.rejects(restoreBackup(path, target), RestoreRefused);
    assert.equal(await target.currentEpoch(), 0, "nothing was written");
    writeFileSync(file, original);
    assert.equal((await verifyBackup(path)).ok, true);
    writeFileSync(join(path, "timers.jsonl"), "");
    assert.match((await verifyBackup(path)).problems.join(";"), /timers/);
    rmSync(join(path, "manifest.json"));
    assert.equal((await verifyBackup(path)).ok, false);
    assert.equal((await listBackups(root)).length, 0, "no manifest, not a backup");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("an interrupted backup leaves no folder that looks complete, and the next one succeeds", async () => {
  const store = new MemoryStorage(); const root = tmp();
  try {
    await populate(store);
    let fail = true;
    const flaky: ControllerStorage = Object.create(store, { snapshot: { value: async () => {
      const s = await store.snapshot();
      return { schemaVersion: s.schemaVersion, close: () => s.close(), read: async (t: never, p: never) => { if (fail && t === "audit") throw new Error("disk went away"); return s.read(t, p); } };
    } } });
    await assert.rejects(createBackup(flaky, { root, kind: "scheduled", version: "t", now: () => new Date(AT) }), /disk went away/);
    assert.deepEqual(readdirSync(root), [], "the partial folder was removed");
    // A crash leaves the partial folder behind: it is not listed, and the next prune clears it once it is old.
    mkdirSync(join(root, "backup-20261028T100000Z-scheduled.partial"));
    writeFileSync(join(root, "backup-20261028T100000Z-scheduled.partial", "operations.jsonl"), "{}\n");
    assert.equal((await listBackups(root)).length, 0);
    fail = false;
    await createBackup(flaky, { root, kind: "scheduled", version: "t", now: () => new Date(AT) });
    assert.equal((await listBackups(root)).length, 1);
    const old = new Date("2026-10-28T10:00:00.000Z");
    utimesSync(join(root, "backup-20261028T100000Z-scheduled.partial"), old, old);
    const pruned = await pruneBackups(root, { now: () => new Date(AT) });
    assert.equal(pruned.partialsRemoved.length, 1);
    assert.equal(existsSync(join(root, "backup-20261028T100000Z-scheduled.partial")), false);
    assert.equal((await listBackups(root)).length, 1, "the good backup stays");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

const info = (iso: string, kind: BackupKind = "scheduled"): BackupInfo => ({ path: `/b/${iso}-${kind}`, manifest: { createdAt: iso, kind } as never });

test("retention keeps the newest of the last 7 days and 4 weeks, the newest of all, and every pre-upgrade snapshot", () => {
  const days = Array.from({ length: 40 }, (_, i) => info(new Date(Date.UTC(2026, 9, 29) - i * 86_400_000 + 3 * 3_600_000).toISOString()));
  const extra = [info("2026-10-29T15:00:00.000Z", "manual"), info("2026-08-01T03:00:00.000Z", "pre-upgrade")];
  const kept = chooseKept([...days, ...extra]);
  const keptDays = [...kept].filter((p) => !p.includes("pre-upgrade")).map((p) => p.slice(3, 13));
  assert.ok(keptDays.includes("2026-10-29"));
  for (let i = 0; i < 7; i++) assert.ok(keptDays.includes(new Date(Date.UTC(2026, 9, 29) - i * 86_400_000).toISOString().slice(0, 10)), `day ${i} kept`);
  assert.ok(kept.has("/b/2026-10-29T15:00:00.000Z-manual"), "the newest of the day is the later one");
  assert.ok(!kept.has("/b/2026-10-29T03:00:00.000Z-scheduled"), "the earlier one of that day goes");
  assert.ok(kept.has("/b/2026-08-01T03:00:00.000Z-pre-upgrade"));
  assert.ok(kept.size <= 7 + 4 + 2, `kept ${kept.size}`);
  // The newest backup is never removed even when it is the only one and old.
  assert.deepEqual([...chooseKept([info("2020-01-01T00:00:00.000Z")])], ["/b/2020-01-01T00:00:00.000Z-scheduled"]);
  assert.equal(chooseKept([]).size, 0);
});

test("the nightly run makes a backup only when the newest is older than a day, one at a time, and a failure is remembered without losing a good backup", async () => {
  const store = new MemoryStorage(); const root = tmp();
  let clock = Date.parse(AT);
  try {
    await populate(store);
    const service = new BackupService(store, { root, version: "t", now: () => new Date(clock) });
    assert.equal(await service.runScheduled(), true);
    clock += 3_600_000;
    assert.equal(await service.runScheduled(), false, "an hour later, nothing to do");
    clock += 24 * 3_600_000;
    const [one, two] = await Promise.all([service.backUpNow(), service.backUpNow()]);
    assert.equal(one.path, two.path, "a second ask while one runs gets that one");
    assert.equal((await service.status()).count, 2);
    // A failing run is reported, and the good backups stay.
    const broken = new BackupService(Object.create(store, { snapshot: { value: async () => { throw new Error("no space left"); } } }), { root, version: "t", now: () => new Date(clock + 1000) });
    await assert.rejects(broken.backUpNow(), /no space left/);
    assert.match((await broken.status()).lastError?.message ?? "", /no space left/);
    assert.equal((await broken.status()).count, 2);
    assert.equal(readdirSync(root).filter((n) => n.endsWith(".partial")).length, 0);
    // A failed scheduled run is not tried again at once (a full disk would be hit every tick), but is after the wait.
    let tries = 0;
    const flaky = new BackupService(Object.create(store, { snapshot: { value: async () => { tries++; throw new Error("no space left"); } } }), { root, version: "t", now: () => new Date(clock + 2 * 24 * 3_600_000), retryAfterMs: 600_000 });
    assert.equal(await flaky.runScheduled(), false);
    assert.equal(await flaky.runScheduled(), false);
    assert.equal(tries, 1, "the second tick did not try again");
    clock += 3 * 24 * 3_600_000;
    const later = new BackupService(Object.create(store, { snapshot: { value: async () => { tries++; throw new Error("no space left"); } } }), { root, version: "t", now: () => new Date(clock), retryAfterMs: 600_000 });
    assert.equal(await later.runScheduled(), false);
    assert.equal(tries, 2);
    // A backups folder that cannot be read is also a failed run, shown in the status.
    const file = join(root, "not-a-folder");
    writeFileSync(file, "x");
    const unreadable = new BackupService(store, { root: file, version: "t", now: () => new Date(clock) });
    assert.equal(await unreadable.runScheduled(), false);
    assert.ok((await unreadable.status()).lastError !== undefined, "the unreadable folder is reported, not lost");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("the artifact blobs are in the backup, checked against their names, and come back into a new artifact store (card K01)", async () => {
  const store = new MemoryStorage(); const target = new MemoryStorage(); const root = tmp(); const live = tmp(); const fresh = tmp();
  try {
    await populate(store);
    const blobs = await FileBlobStore.open({ directory: live });
    const one = await blobs.put(new TextEncoder().encode("the north bed plan"));
    const two = await blobs.put(new TextEncoder().encode("photos of the beds"));
    // One blob has gone bad on disk since it was stored: it is left out of the copy and named, never copied as if it were fine.
    const three = await blobs.put(new TextEncoder().encode("a third file"));
    chmodSync(blobs.pathOf(three.digest), 0o644);
    writeFileSync(blobs.pathOf(three.digest), "rotten");
    const { path, manifest } = await createBackup(store, { root, kind: "manual", version: "t", now: () => new Date(AT), blobs });
    assert.equal(manifest.artifacts?.blobs, 2);
    assert.deepEqual(manifest.artifacts?.skipped, [{ digest: three.digest, why: "corrupt" }]);
    assert.equal((await verifyBackup(path)).ok, true);
    await assert.rejects(restoreBackup(path, target), (e: unknown) => e instanceof RestoreRefused && /no artifact store/.test(e.message));
    assert.equal(await target.currentEpoch(), 0, "refused before anything was written");
    const into = await FileBlobStore.open({ directory: fresh });
    const done = await restoreBackup(path, target, { blobs: into });
    assert.equal(done.blobsRestored, 2);
    assert.equal(new TextDecoder().decode(await into.read(one.digest)), "the north bed plan");
    assert.equal(await into.has(two.digest), true);
    assert.equal(await into.has(three.digest), false);
    // A blob changed inside the backup is caught.
    chmodSync(join(path, "artifacts", one.digest), 0o644);
    writeFileSync(join(path, "artifacts", one.digest), "changed");
    const bad = await verifyBackup(path);
    assert.equal(bad.ok, false);
    assert.match(bad.problems.join(";"), /artifacts: blob/);
  } finally { rmSync(root, { recursive: true, force: true }); rmSync(live, { recursive: true, force: true }); rmSync(fresh, { recursive: true, force: true }); }
});

test("the artifact store is locked against orphan cleanup from before the database is read until the blobs are copied (card K01)", async () => {
  const store = new MemoryStorage(); const root = tmp(); const live = tmp();
  try {
    await populate(store);
    const blobs = await FileBlobStore.open({ directory: live });
    await blobs.put(new TextEncoder().encode("a plan"));
    const events: string[] = [];
    const watched = Object.create(store, { snapshot: { value: async () => { events.push("snapshot"); return store.snapshot(); } } });
    let release!: () => void;
    const held = blobs.lock.exclusive(async () => { events.push("cleanup-start"); await new Promise<void>((r) => { release = r; }); events.push("cleanup-end"); });
    await new Promise((r) => setTimeout(r, 20));
    const made = createBackup(watched, { root, kind: "manual", version: "t", now: () => new Date(AT), blobs });
    await new Promise((r) => setTimeout(r, 50));
    assert.deepEqual(events, ["cleanup-start"], "the backup waits for a running cleanup before reading anything");
    release(); await held; await made;
    assert.deepEqual(events, ["cleanup-start", "cleanup-end", "snapshot"]);
    // A cleanup that arrives while the backup runs waits for it.
    const cleanup = blobs.lock.exclusive(async () => { events.push("cleanup-2"); });
    await cleanup;
  } finally { rmSync(root, { recursive: true, force: true }); rmSync(live, { recursive: true, force: true }); }
});

test("a repeated ask gets the backup its first ask made, unless that backup has since been removed, and then it gets a new one", async () => {
  const store = new MemoryStorage(); const root = tmp();
  let clock = Date.parse(AT);
  try {
    await populate(store);
    const service = new BackupService(store, { root, version: "t", now: () => new Date(clock) });
    const first = await service.backUpFor("cmd-1");
    clock += 5000;
    assert.equal((await service.backUpFor("cmd-1")).path, first.path, "the same ask, the same backup");
    rmSync(first.path, { recursive: true, force: true });
    const again = await service.backUpFor("cmd-1");
    assert.notEqual(again.path, first.path, "the backup was removed, so the ask gets a new one");
    assert.ok(existsSync(again.path));
    assert.equal((await service.backUpFor("cmd-1")).path, again.path);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
