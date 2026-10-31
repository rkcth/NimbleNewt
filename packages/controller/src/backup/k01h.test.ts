import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, sep } from "node:path";
import { test } from "node:test";
import { DomainError } from "../domain/errors.js";
import { MemoryStorage, SqliteStorage } from "../storage/index.js";
import { BackupEncryption, BackupService, MaintenanceBarrier, RestoreRefused, StagedRestore, applyPendingRestore, createBackup, createKeyring, restoreBackup, validRel, verifyBackup, type PiStateSource } from "./index.js";

const AT = "2026-10-31T10:00:00.000Z";
const FAST = { N: 2 ** 16, r: 8, p: 1 } as const;
const PASS = "correct horse battery staple 42";
const POSIX = process.platform !== "win32";
const tmp = (): string => mkdtempSync(join(tmpdir(), "nn-k01h-"));
const SECRET_LINE = '{"id":1,"kind":"pi.user","text":"pi-secret-conversation-5521"}\n';

async function populate(storage: MemoryStorage | SqliteStorage, title = "café"): Promise<void> {
  const { epoch } = await storage.acquireEpoch({ holder: "c1", at: AT });
  await storage.applyOperation({ operationId: "op-1", epoch, actor: "owner:rob", correlationId: "co-1", at: AT, changes: [{ type: "create", ref: { kind: "task", id: "task-a" }, body: { title } }], audit: [{ type: "task.created", detail: {} }], outbox: [], effects: [], timers: [], cancelTimers: [], completeDeliveries: [], completeTimers: [], settleEffects: [] });
}
function makeStores(dir: string): PiStateSource {
  mkdirSync(join(dir, "att-1", "sub"), { recursive: true });
  // A worker that was writing when the copy ran leaves half a line: it is not part of the copy.
  writeFileSync(join(dir, "att-1", "history.jsonl"), `${SECRET_LINE}{"id":2,"kind":"pi.assis`);
  writeFileSync(join(dir, "att-1", "sub", "marker.json"), '{"format":1}');
  mkdirSync(join(dir, "att-2"));
  writeFileSync(join(dir, "att-2", "history.jsonl"), SECRET_LINE);
  return { list: async () => [{ id: "att-1", dir: join(dir, "att-1") }, { id: "att-2", dir: join(dir, "att-2") }] };
}

test("the agents' conversation stores are in the backup, verified, and come back byte for byte; a half-written last line is left out (card K01h)", async () => {
  const d = tmp();
  try {
    const store = new MemoryStorage(); await populate(store);
    const { path, manifest } = await createBackup(store, { root: join(d, "b"), kind: "manual", version: "t", now: () => new Date(AT), piState: makeStores(join(d, "live")) });
    assert.equal(manifest.piState?.stores, 2); assert.equal(manifest.piState?.files, 3);
    assert.equal((await verifyBackup(path)).ok, true);
    // No restore without a place to put them.
    await assert.rejects(restoreBackup(path, new MemoryStorage()), (e: unknown) => e instanceof RestoreRefused && /conversation stores/.test(e.message));
    const target = new MemoryStorage();
    const done = await restoreBackup(path, target, { piTarget: (id) => join(d, "out", id) });
    assert.deepEqual([done.piStoresRestored, done.piFilesRestored], [2, 3]);
    assert.equal(readFileSync(join(d, "out", "att-1", "history.jsonl"), "utf8"), SECRET_LINE);
    assert.equal(readFileSync(join(d, "out", "att-1", "sub", "marker.json"), "utf8"), '{"format":1}');
    // A changed byte in a conversation file is refused before anything is written.
    const stored = readdirSync(join(path, "pi-state")).sort()[0]!;
    writeFileSync(join(path, "pi-state", stored), "tampered", { flag: "a" });
    const bad = await verifyBackup(path);
    assert.equal(bad.ok, false); assert.match(bad.problems.join(";"), /pi state/);
    const other = new MemoryStorage();
    await assert.rejects(restoreBackup(path, other, { piTarget: (id) => join(d, "out2", id) }), RestoreRefused);
    assert.equal(existsSync(join(d, "out2")), false);
    assert.equal(await other.currentEpoch(), 0);
  } finally { rmSync(d, { recursive: true, force: true }); }
});

test("a restore never writes into a conversation folder that already has files, and index paths cannot leave their store (card K01h)", async () => {
  const d = tmp();
  try {
    const store = new MemoryStorage(); await populate(store);
    const { path } = await createBackup(store, { root: join(d, "b"), kind: "manual", version: "t", now: () => new Date(AT), piState: makeStores(join(d, "live")) });
    mkdirSync(join(d, "out", "att-1"), { recursive: true }); writeFileSync(join(d, "out", "att-1", "mine.txt"), "keep");
    await assert.rejects(restoreBackup(path, new MemoryStorage(), { piTarget: (id) => join(d, "out", id) }), (e: unknown) => e instanceof RestoreRefused && /not empty/.test(e.message));
    assert.equal(readFileSync(join(d, "out", "att-1", "mine.txt"), "utf8"), "keep");
    for (const bad of ["../x", "/abs", "C:/x", "a\\b", "a//b", "", "a/./b", "a/../b", "a/b:c"]) assert.equal(validRel(bad), false, bad);
    for (const good of ["a", "a/b.jsonl", "sub/dir/f.json"]) assert.equal(validRel(good), true, good);
  } finally { rmSync(d, { recursive: true, force: true }); }
});

test("an encrypted backup seals the conversation files too: nothing readable on disk, and the passcode restores them (card K01h)", async () => {
  const d = tmp();
  try {
    const { keyring } = await createKeyring({ passcode: PASS, scrypt: FAST });
    const store = new MemoryStorage(); await populate(store);
    const { path, manifest } = await createBackup(store, { root: join(d, "b"), kind: "manual", version: "t", now: () => new Date(AT), encryption: keyring, piState: makeStores(join(d, "live")) });
    const all = Buffer.concat(readdirSync(path, { recursive: true, withFileTypes: true }).filter((e) => e.isFile()).map((e) => readFileSync(join(e.parentPath, e.name))));
    assert.equal(all.includes("pi-secret-conversation-5521"), false);
    assert.equal(readdirSync(join(path, "pi-state")).every((n) => /^f-\d+\.enc$/.test(n)), true);
    assert.ok(manifest.mac);
    const { unlockWithPasscode } = await import("./index.js");
    const key = await unlockWithPasscode(keyring, PASS);
    assert.equal((await verifyBackup(path, { unlock: key })).ok, true);
    await restoreBackup(path, new MemoryStorage(), { unlock: key, piTarget: (id) => join(d, "out", id) });
    assert.equal(readFileSync(join(d, "out", "att-2", "history.jsonl"), "utf8"), SECRET_LINE);
    // A manifest that drops the Pi state is refused (the MAC covers it).
    const m = JSON.parse(readFileSync(join(path, "manifest.json"), "utf8")); delete m.piState; writeFileSync(join(path, "manifest.json"), JSON.stringify(m));
    assert.equal((await verifyBackup(path, { unlock: key })).ok, false);
  } finally { rmSync(d, { recursive: true, force: true }); }
});

test("the maintenance barrier holds participants in order, lets them go in reverse, undoes a failed raise and allows one at a time (card K01h)", async () => {
  const log: string[] = [];
  const b = new MaintenanceBarrier();
  b.add({ name: "a", hold: async () => { log.push("hold a"); return () => { log.push("release a"); }; } });
  b.add({ name: "b", hold: async () => { log.push("hold b"); return () => { log.push("release b"); }; } });
  assert.equal(b.held, false); b.check();
  await b.run("test", async () => {
    assert.equal(b.held, true);
    assert.throws(() => b.check(), (e: unknown) => e instanceof DomainError && e.code === "unavailable");
    await assert.rejects(b.raise("second"), /already in maintenance/);
  });
  assert.deepEqual(log, ["hold a", "hold b", "release b", "release a"]);
  assert.equal(b.held, false);
  log.length = 0;
  b.add({ name: "c", hold: async () => { throw new Error("busy"); } });
  await assert.rejects(b.raise("x"), /c busy/);
  assert.deepEqual(log, ["hold a", "hold b", "release b", "release a"], "what was held is let go");
  assert.equal(b.held, false);
});

async function rig() {
  const d = tmp();
  const data = join(d, "data"); mkdirSync(data);
  const live = join(d, "live");
  const pi = makeStores(live);
  const sqlite = join(data, "c.sqlite");
  let storage = await SqliteStorage.open({ path: sqlite });
  await populate(storage, "before");
  const backups = new BackupService(storage, { root: join(d, "b"), version: "t", now: () => new Date(AT), piState: pi });
  const made = await backups.backUpNow("manual");
  // Afterwards the live data changes: this is what a restore must roll back.
  const { epoch } = { epoch: await storage.currentEpoch() };
  await storage.applyOperation({ operationId: "op-2", epoch, actor: "owner:rob", correlationId: "co-2", at: AT, changes: [{ type: "create", ref: { kind: "task", id: "task-late" }, body: { title: "late" } }], audit: [], outbox: [], effects: [], timers: [], cancelTimers: [], completeDeliveries: [], completeTimers: [], settleEffects: [] });
  writeFileSync(join(live, "att-1", "history.jsonl"), `${SECRET_LINE}{"id":9,"kind":"pi.user","text":"after the backup"}\n`);
  const barrier = new MaintenanceBarrier();
  barrier.add({ name: "backups", hold: async () => backups.hold() });
  let staged = 0;
  const restore = (extra: Partial<ConstructorParameters<typeof StagedRestore>[0]> = {}) => new StagedRestore({ backups, root: join(d, "b"), barrier, sqlitePath: sqlite, dataDirectory: data, storage, piFinal, onStaged: () => { staged += 1; }, now: () => new Date("2026-10-31T11:00:00.000Z"), ...extra });
  const piFinal = (id: string): string => join(live, id);
  return { d, data, live, sqlite, piFinal, backups, made, barrier, restore, get storage() { return storage; }, set storage(s) { storage = s; }, staged: () => staged };
}

test("a restore from inside the controller is previewed, needs the approved token, snapshots the current state, holds the barrier and swaps in at the next start; the old data is kept (card K01h)", async () => {
  const r = await rig();
  try {
    const sr = r.restore();
    const plan = await sr.preview(r.made.manifest.name);
    assert.equal(plan.piFiles, 3); assert.equal(plan.encrypted, false); assert.ok(plan.steps.length >= 4);
    await assert.rejects(sr.apply(plan.name, "not-the-token"), (e: unknown) => e instanceof DomainError && /token/.test(e.message));
    assert.equal(r.barrier.held, false, "a refused apply leaves no barrier and nothing staged");
    assert.equal(existsSync(join(r.data, "pending-restore.json")), false);
    const done = await sr.apply(plan.name, plan.token);
    assert.equal(r.staged(), 1);
    assert.equal(r.barrier.held, true);
    await assert.rejects(r.backups.backUpNow("manual"), /maintenance/);
    assert.match(done.safetyCopy, /pre-restore/);
    // The live data is untouched until the restart.
    assert.equal((await r.storage.getAggregate({ kind: "task", id: "task-late" }))?.body["title"], "late");
    assert.match(readFileSync(join(r.live, "att-1", "history.jsonl"), "utf8"), /after the backup/);
    await assert.rejects(sr.apply(plan.name, plan.token), /already/);
    await r.storage.close();
    // The next start.
    const applied = await applyPendingRestore(r.data, r.sqlite, undefined, { piFinal: r.piFinal });
    assert.equal(applied, r.made.manifest.name);
    assert.equal(await applyPendingRestore(r.data, r.sqlite, undefined, { piFinal: r.piFinal }), undefined, "applied once");
    const back = await SqliteStorage.open({ path: r.sqlite });
    try {
      assert.equal((await back.getAggregate({ kind: "task", id: "task-a" }))?.body["title"], "before");
      assert.equal(await back.getAggregate({ kind: "task", id: "task-late" }), undefined);
    } finally { await back.close(); }
    assert.equal(readFileSync(join(r.live, "att-1", "history.jsonl"), "utf8"), SECRET_LINE);
    const kept = readdirSync(r.data).filter((n) => n.includes(".before-restore-"));
    assert.ok(kept.length >= 1, "the old database is kept");
    assert.ok(readdirSync(r.live).some((n) => n.startsWith("att-1.before-restore-")), "the old conversation folder is kept");
    assert.match(readFileSync(join(r.live, readdirSync(r.live).find((n) => n.startsWith("att-1.before-restore-"))!, "history.jsonl"), "utf8"), /after the backup/);
    assert.equal(readdirSync(r.data).some((n) => n.includes(".nn-staged-")) || readdirSync(r.live).some((n) => n.includes(".nn-staged-")), false, "staging is gone");
  } finally { rmSync(r.d, { recursive: true, force: true }); }
});

test("a prepared restore can be cancelled and leaves the live data exactly as it was; a refused barrier stages nothing that stays (card K01h)", async () => {
  const r = await rig();
  try {
    const sr = r.restore();
    const plan = await sr.preview(r.made.manifest.name);
    await sr.apply(plan.name, plan.token);
    assert.equal((await sr.cancel()).cancelled, true);
    assert.equal(r.barrier.held, false);
    assert.equal(existsSync(join(r.data, "pending-restore.json")), false);
    assert.equal(existsSync(`${r.sqlite}.nn-staged-20261031T110000Z`), false);
    assert.equal((await r.storage.getAggregate({ kind: "task", id: "task-late" }))?.body["title"], "late");
    assert.equal((await sr.cancel()).cancelled, false);
    // A participant that refuses (work still running) stops the restore and clears the staging.
    r.barrier.add({ name: "work", hold: async () => { throw new Error("2 agent attempts are still running"); } });
    const plan2 = await sr.preview(r.made.manifest.name);
    await assert.rejects(sr.apply(plan2.name, plan2.token), /work 2 agent attempts/);
    assert.equal(r.barrier.held, false);
    assert.equal(existsSync(join(r.data, "pending-restore.json")), false);
    assert.equal(existsSync(`${r.sqlite}.nn-staged-20261031T110000Z`), false);
    await assert.rejects(sr.preview("backup-20200101T000000Z-manual"), /no complete backup/);
    await assert.rejects(sr.preview("../etc"), /name of a backup/);
  } finally { rmSync(r.d, { recursive: true, force: true }); }
});

test("an interrupted swap is finished by the next start, and a marker for another database or with paths outside its staging is refused (card K01h)", async () => {
  const r = await rig();
  try {
    const sr = r.restore();
    const plan = await sr.preview(r.made.manifest.name);
    await sr.apply(plan.name, plan.token);
    await r.storage.close();
    // Crash after the conversation folders were swapped but before the database was: run the swap by hand for the folders, then start.
    const marker = JSON.parse(readFileSync(join(r.data, "pending-restore.json"), "utf8"));
    await assert.rejects(applyPendingRestore(r.data, join(r.d, "other.sqlite"), undefined, { piFinal: r.piFinal }), /not for this database/);
    const { renameSync } = await import("node:fs");
    for (const p of marker.pi) { renameSync(p.target, `${p.target}.before-restore-${marker.stamp}`); renameSync(p.staged, p.target); }
    assert.equal(await applyPendingRestore(r.data, r.sqlite, undefined, { piFinal: r.piFinal }), r.made.manifest.name);
    const back = await SqliteStorage.open({ path: r.sqlite });
    try { assert.equal(await back.getAggregate({ kind: "task", id: "task-late" }), undefined); } finally { await back.close(); }
    // A marker that anything else wrote (names files elsewhere, no valid MAC) is refused.
    writeFileSync(join(r.data, "pending-restore.json"), JSON.stringify({ ...marker, pi: [{ id: "att-1", staged: join(r.d, "elsewhere"), target: join(r.d, "t") }] }));
    await assert.rejects(applyPendingRestore(r.data, r.sqlite, undefined, { piFinal: r.piFinal }), /not authentic/);
  } finally { rmSync(r.d, { recursive: true, force: true }); }
});

test("an encrypted backup is restored from inside the controller with the passcode from the host file; the passcode never reaches the plan (card K01h)", { skip: !POSIX && "secret files need POSIX modes" }, async () => {
  const d = tmp();
  try {
    const data = join(d, "data"); mkdirSync(data);
    const sqlite = join(data, "c.sqlite");
    const { keyring } = await createKeyring({ passcode: PASS, scrypt: FAST });
    const passFile = join(d, "pass"); writeFileSync(passFile, PASS, { mode: 0o600 }); chmodSync(passFile, 0o600);
    const enc = new BackupEncryption({ keyring, passcodeFile: passFile });
    const storage = await SqliteStorage.open({ path: sqlite }); await populate(storage, "sealed");
    const backups = new BackupService(storage, { root: join(d, "b"), version: "t", now: () => new Date(AT), encryption: keyring, piState: makeStores(join(d, "live")) });
    const made = await backups.backUpNow("manual");
    const barrier = new MaintenanceBarrier(); barrier.add({ name: "backups", hold: async () => backups.hold() });
    const sr = new StagedRestore({ backups, root: join(d, "b"), barrier, sqlitePath: sqlite, dataDirectory: data, storage, piFinal: (id) => join(d, "live", id), unlock: (m) => enc.unlock(m), now: () => new Date("2026-10-31T11:00:00.000Z") });
    const plan = await sr.preview(made.manifest.name);
    assert.equal(plan.encrypted, true); assert.equal(plan.effectsToMarkUncertain, undefined);
    assert.equal(JSON.stringify(plan).includes(PASS), false);
    const done = await sr.apply(plan.name, plan.token, "passcode");
    assert.equal(done.result.piFilesRestored, 3);
    assert.equal(JSON.stringify(done).includes(PASS), false);
    await storage.close();
    assert.equal(await applyPendingRestore(data, sqlite, undefined, { piFinal: (id) => join(d, "live", id) }), made.manifest.name);
    // Without the passcode file there is no restore, and nothing is staged.
    const again = await SqliteStorage.open({ path: sqlite });
    try {
      const none = new StagedRestore({ backups, root: join(d, "b"), barrier: new MaintenanceBarrier(), sqlitePath: sqlite, dataDirectory: data, storage: again, now: () => new Date("2026-10-31T12:00:00.000Z") });
      const plan2 = await none.preview(made.manifest.name);
      await assert.rejects(none.apply(plan2.name, plan2.token), /no unlock method/);
      assert.equal(existsSync(join(data, "pending-restore.json")), false);
    } finally { await again.close(); }
  } finally { rmSync(d, { recursive: true, force: true }); }
});

test("path separators: the index keeps forward slashes whatever the platform (card K01h)", async () => {
  const d = tmp();
  try {
    const store = new MemoryStorage(); await populate(store);
    const { path } = await createBackup(store, { root: join(d, "b"), kind: "manual", version: "t", now: () => new Date(AT), piState: makeStores(join(d, "live")) });
    const index = readFileSync(join(path, "pi-state.jsonl"), "utf8");
    assert.ok(index.includes('"rel":"sub/marker.json"'));
    assert.equal(index.includes("\\\\"), false);
    assert.ok(sep.length === 1);
  } finally { rmSync(d, { recursive: true, force: true }); }
});
