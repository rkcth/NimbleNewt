import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { FileBlobStore } from "../artifacts/index.js";
import { BackupService, MaintenanceBarrier, PENDING_FILE, StagedRestore, restoreBackup } from "../backup/index.js";
import { backends, stopServer } from "../domain/testing/backends.js";
import { DomainError } from "../domain/errors.js";
import { MemoryStorage, SqliteStorage, type ControllerStorage, type SnapshotRow } from "../storage/index.js";
import { AuthorityCarryRefused, assertStartAllowed, authorityOfRow, authoritySideOf, carryControllerAuthority, promoteController, readControllerAuthority, writeFencedRecoveryManifest, type AuthoritySide } from "./index.js";

// Card K05, second slice: a backup restore carries the running store's controller authority (epoch, holder, promotion record) into the restored store, so a backup made before a promotion does
// not bring back the controller that promotion replaced. The decision alone, with hostile inputs; then a real restore into an empty store on each of the four backends.

after(stopServer);
const T = "2026-11-27T12:00:00.000Z";
const now = () => new Date(T);
const tmp = (): string => mkdtempSync(join(tmpdir(), "nn-k05c-"));
const gone = (d: string): void => rmSync(d, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });

const record = (over: Record<string, unknown> = {}, revision = 2): SnapshotRow => ({
  kind: "controller-authority", id: "primary", revision, created_at: T, updated_at: T,
  body: JSON.stringify({ format: 1, promotionId: "p1", state: "promoted", successor: "ctl-b", fencedEpoch: 3, fencedHolder: "ctl-a", fenceEpoch: 4, at: T, ...over }),
});
const refusedCarry = (pattern: RegExp) => (e: unknown): boolean => { assert.ok(e instanceof AuthorityCarryRefused, String(e)); assert.match((e as Error).message, pattern); assert.match((e as Error).message, /nothing was changed/); return true; };

test("the newer side by epoch decides epoch, holder and record together; a tie goes to the running store; the live store without a record leaves none (K05 second slice)", () => {
  const live: AuthoritySide = { epoch: 5, holder: "ctl-b", authority: record() };
  // backup made before the promotion: no record, the replaced controller's epoch and holder
  assert.deepEqual(carryControllerAuthority(live, { epoch: 3, holder: "ctl-a" }), { from: "live", epoch: 5, holder: "ctl-b", authority: live.authority, record: authorityOfRow(live.authority) });
  // backup with a different (older) promotion record: the live one replaces it
  const older = record({ promotionId: "p0", successor: "ctl-a", fencedEpoch: 1, fencedHolder: "ctl-z", fenceEpoch: 2 });
  const r = carryControllerAuthority(live, { epoch: 3, holder: "ctl-a", authority: older });
  assert.equal(r.authority, live.authority); assert.equal(r.epoch, 5); assert.equal(r.holder, "ctl-b");
  // a tie is the running store's
  assert.equal(carryControllerAuthority({ epoch: 3, holder: "ctl-b" }, { epoch: 3, holder: "ctl-a", authority: older }).from, "live");
  assert.equal(carryControllerAuthority({ epoch: 3, holder: "ctl-b" }, { epoch: 3, holder: "ctl-a", authority: older }).authority, null, "a restore never adds a promotion the running store does not have");
  // live without a record and the backup older: none
  assert.deepEqual(carryControllerAuthority({ epoch: 9, holder: "controller" }, { epoch: 4, holder: "ctl-a", authority: record() }), { from: "live", epoch: 9, holder: "controller", authority: null });
  // the backup newer than the running store (a fresh installation restoring another's backup): the backup's three
  const b = carryControllerAuthority({ epoch: 1, holder: "controller" }, { epoch: 8, holder: "ctl-b", authority: record() });
  assert.equal(b.from, "backup"); assert.equal(b.epoch, 8); assert.equal(b.holder, "ctl-b"); assert.equal(b.record?.successor, "ctl-b");
  assert.deepEqual(carryControllerAuthority({ epoch: 1, holder: "controller" }, { epoch: 8, holder: "x" }), { from: "backup", epoch: 8, holder: "x", authority: null });
  // a fence carried as it is (a promotion that stopped before its record): it keeps every start out, as on the running store
  assert.equal(carryControllerAuthority({ epoch: 6, holder: "promotion-fence:p9:5:ctl-a" }, { epoch: 2, holder: "ctl-a" }).holder, "promotion-fence:p9:5:ctl-a");
});

test("a backup newer by epoch never drops a promotion the running store holds: it must hold the same promotion or a later one (K05 second slice, first review)", () => {
  const live: AuthoritySide = { epoch: 5, holder: "ctl-b", authority: record() }; // p1, fenceEpoch 4, successor ctl-b, fenced ctl-a
  // an old controller's own copy, restarted there past the live epoch: no record, or an earlier promotion's
  assert.throws(() => carryControllerAuthority(live, { epoch: 8, holder: "ctl-a" }), refusedCarry(/does not hold the controller promotion p1 .*replaced start again/));
  assert.throws(() => carryControllerAuthority(live, { epoch: 8, holder: "ctl-a", authority: record({ promotionId: "p0", successor: "ctl-a", fencedEpoch: 1, fencedHolder: "ctl-z", fenceEpoch: 2 }) }), refusedCarry(/does not hold the controller promotion p1/));
  // another promotion at the same fence epoch (two copies promoted apart): refused
  assert.throws(() => carryControllerAuthority(live, { epoch: 8, holder: "ctl-q", authority: record({ promotionId: "pq", successor: "ctl-q" }) }), refusedCarry(/does not hold the controller promotion p1/));
  // the same promotion, or a later one, at a later epoch: the backup's three
  const same = carryControllerAuthority(live, { epoch: 8, holder: "ctl-b", authority: record() });
  assert.equal(same.from, "backup"); assert.equal(same.epoch, 8); assert.equal(same.record?.promotionId, "p1");
  const later = carryControllerAuthority(live, { epoch: 9, holder: "ctl-c", authority: record({ promotionId: "p2", successor: "ctl-c", fencedEpoch: 6, fencedHolder: "ctl-b", fenceEpoch: 7 }) });
  assert.equal(later.from, "backup"); assert.equal(later.record?.promotionId, "p2");
  // a running store held by a promotion's fence without its record: the backup must hold that promotion at that fence epoch, or a later one
  const fenced: AuthoritySide = { epoch: 6, holder: "promotion-fence:p9:5:ctl-a" };
  assert.throws(() => carryControllerAuthority(fenced, { epoch: 8, holder: "ctl-a" }), refusedCarry(/does not hold the controller promotion p9/));
  assert.throws(() => carryControllerAuthority(fenced, { epoch: 8, holder: "ctl-b", authority: record({ promotionId: "p9", fencedEpoch: 5, fenceEpoch: 5 }) }), refusedCarry(/does not hold the controller promotion p9/));
  assert.equal(carryControllerAuthority(fenced, { epoch: 8, holder: "ctl-b", authority: record({ promotionId: "p9", fencedEpoch: 5, fenceEpoch: 6 }) }).from, "backup");
  // second review: the record of p1 and the fence of a later promotion p9 that stopped before its record (ctl-b, p1's successor, fenced at 6): a newer backup of ctl-b's own copy holding only
  // p1 would let ctl-b start; it must cover p9 too
  const both: AuthoritySide = { epoch: 6, holder: "promotion-fence:p9:5:ctl-b", authority: record() };
  assert.throws(() => carryControllerAuthority(both, { epoch: 8, holder: "ctl-b", authority: record() }), refusedCarry(/does not hold the controller promotion p9 .*Restore a backup made on this database since that promotion instead; .*a new installation/));
  assert.throws(() => carryControllerAuthority(both, { epoch: 8, holder: "ctl-b", authority: record({ promotionId: "pz", fenceEpoch: 6 }) }), refusedCarry(/does not hold the controller promotion p9/));
  assert.equal(carryControllerAuthority(both, { epoch: 8, holder: "ctl-c", authority: record({ promotionId: "p9", successor: "ctl-c", fencedEpoch: 5, fencedHolder: "ctl-b", fenceEpoch: 6 }) }).record?.successor, "ctl-c");
  assert.equal(carryControllerAuthority(both, { epoch: 3, holder: "ctl-a" }).holder, "promotion-fence:p9:5:ctl-b", "an older backup takes the fence and the record as they are");
  // re-check: the record counts beside a fence too (a record and a fence of different promotions at the same epoch is not a state a promotion writes; it is refused unless both are covered)
  const odd: AuthoritySide = { epoch: 6, holder: "promotion-fence:p9:5:ctl-b", authority: record({ promotionId: "pz", fencedEpoch: 5, fenceEpoch: 6 }) };
  assert.throws(() => carryControllerAuthority(odd, { epoch: 8, holder: "ctl-c", authority: record({ promotionId: "p9", successor: "ctl-c", fencedEpoch: 5, fencedHolder: "ctl-b", fenceEpoch: 6 }) }), refusedCarry(/does not hold the controller promotion pz/));
  // no promotion on the running store: a newer backup is taken as it is, with or without a record
  assert.equal(carryControllerAuthority({ epoch: 2, holder: "controller" }, { epoch: 8, holder: "x" }).authority, null);
  // a tie still goes to the running store, whatever the backup holds
  const tie = carryControllerAuthority(live, { epoch: 5, holder: "ctl-a" });
  assert.equal(tie.authority, live.authority); assert.equal(tie.holder, "ctl-b", "a tie keeps the running store's holder, not the backup's");
});

test("records and states that do not read are refused, never carried or dropped silently (K05 second slice)", () => {
  const backup: AuthoritySide = { epoch: 3, holder: "ctl-a" };
  for (const [label, row] of [
    ["not JSON", { ...record(), body: "{nope" }], ["an array", { ...record(), body: "[]" }], ["another format", record({ format: 2 })], ["a state not known", record({ state: "taken" })],
    ["a successor that is no holder name", record({ successor: "a b" })], ["revision 0", record({}, 0)], ["revision not whole", { ...record(), revision: 1.5 }], ["a body not text", { ...record(), body: 7 }],
    ["a negative epoch", record({ fenceEpoch: -1 })],
  ] as const) {
    assert.throws(() => carryControllerAuthority({ epoch: 5, holder: "ctl-b", authority: row as SnapshotRow }, backup), refusedCarry(/running database cannot be read/), label);
    // a damaged record in an older backup is replaced by the live one; in a newer backup it decides, and is refused
    assert.equal(carryControllerAuthority({ epoch: 5, holder: "ctl-b", authority: record() }, { ...backup, authority: row as SnapshotRow }).from, "live", label);
    assert.throws(() => carryControllerAuthority({ epoch: 1, holder: "controller" }, { epoch: 8, holder: "ctl-b", authority: row as SnapshotRow }), refusedCarry(/backup's record .* cannot be read/), label);
  }
  // a record of a promotion later than its own store's epoch
  assert.throws(() => carryControllerAuthority({ epoch: 3, holder: "ctl-b", authority: record({ fenceEpoch: 4 }) }, { epoch: 1, holder: null }), refusedCarry(/names epoch 4, later than its store's epoch 3/));
  assert.throws(() => carryControllerAuthority({ epoch: 1, holder: null }, { epoch: 3, holder: "ctl-b", authority: record({ fenceEpoch: 9 }) }), refusedCarry(/backup's record .* names epoch 9/));
  // epochs and holders not in the form a store writes
  for (const epoch of [-1, 1.5, Number.NaN, 2 ** 60]) assert.throws(() => carryControllerAuthority({ epoch, holder: "x" }, backup), refusedCarry(/running database's epoch cannot be read/), String(epoch));
  assert.throws(() => carryControllerAuthority({ epoch: 5, holder: "x" }, { epoch: Number.NaN, holder: "x" }), refusedCarry(/backup's epoch cannot be read/));
  assert.throws(() => carryControllerAuthority({ epoch: 5, holder: 7 as unknown as string }, backup), refusedCarry(/holder cannot be read/));
  assert.throws(() => carryControllerAuthority({ epoch: 5, holder: "x".repeat(501) }, backup), refusedCarry(/holder cannot be read/));
  assert.throws(() => carryControllerAuthority({ epoch: 5, holder: "promotion-fence:bad id:1" }, backup), refusedCarry(/promotion fence that cannot be read/));
  assert.throws(() => carryControllerAuthority({ epoch: 5, holder: "x" }, { epoch: 1, holder: "promotion-fence:p1:0" }), refusedCarry(/backup's store is held by a promotion fence that cannot be read/));
  // a row of another aggregate is not a record
  assert.equal(authorityOfRow({ ...record(), id: "secondary" }), "unreadable");
});

test("a fence holder is read only in the forms a promotion writes, the first slice's form without the replaced holder included; any other text after the prefix is refused on either side (K05 second slice, second review)", () => {
  const older: AuthoritySide = { epoch: 2, holder: "ctl-a" };
  for (const holder of ["promotion-fence:p9:5", "promotion-fence:p9:5:ctl-a", `promotion-fence:${"p".repeat(48)}:5:${"h".repeat(80)}`, "promotion-fence:p9:9007199254740991"]) {
    assert.equal(carryControllerAuthority({ epoch: 6, holder }, older).holder, holder, holder);
  }
  // the old form's fence still guards a newer backup
  assert.throws(() => carryControllerAuthority({ epoch: 6, holder: "promotion-fence:p9:5" }, { epoch: 8, holder: "ctl-a" }), refusedCarry(/does not hold the controller promotion p9/));
  for (const holder of ["promotion-fence:", "promotion-fence::5", "promotion-fence:p9", "promotion-fence:p9:", "promotion-fence:p9:5:", "promotion-fence:p9:5:ctl-a:x", "promotion-fence:p9:05", "promotion-fence:p9:0",
    "promotion-fence:p9:9007199254740993", "promotion-fence:p9:12345678901234567", `promotion-fence:${"p".repeat(49)}:5`, `promotion-fence:p9:5:${"h".repeat(81)}`, "promotion-fence:pé:5", "promotion-fence:p9‮:5",
    "promotion-fence:p9:5\n", "promotion-fence:p9:5:ctl​a", "promotion-fence:-p9:5", "promotion-fence: p9:5", "promotion-fence:p9:5:.ctl"]) {
    assert.throws(() => carryControllerAuthority({ epoch: 6, holder }, older), refusedCarry(/running database's store is held by a promotion fence that cannot be read/), JSON.stringify(holder));
    assert.throws(() => carryControllerAuthority({ epoch: 6, holder: "ctl-b" }, { epoch: 2, holder }), refusedCarry(/backup's store is held by a promotion fence that cannot be read/), JSON.stringify(holder));
  }
  // other holders with colons or other scripts are plain names, not fences
  for (const holder of ["ctl:a:b", "Promotion-fence:p9:5", "x promotion-fence:p9:5", "контроллер"]) assert.equal(carryControllerAuthority({ epoch: 6, holder }, older).holder, holder);
});

const put = (s: ControllerStorage, epoch: number, id: string, kind = "note") => s.applyOperation({
  operationId: `op-${kind}-${id}`, epoch, actor: "t", correlationId: `c-${id}`, at: T, changes: [{ type: "create", ref: { kind, id }, body: { v: id } }],
  audit: [{ type: "note.made", subject: { kind, id }, detail: {} }], outbox: [], effects: [], timers: [], cancelTimers: [], completeDeliveries: [], completeTimers: [], settleEffects: [],
});
const stateOf = async (s: ControllerStorage): Promise<SnapshotRow | undefined> => { const snap = await s.snapshot(); try { return (await snap.read("state", { limit: 1 }))[0]; } finally { await snap.close(); } };
const liveSide = async (s: ControllerStorage): Promise<AuthoritySide> => { const snap = await s.snapshot(); try { return await authoritySideOf(snap); } finally { await snap.close(); } };
/** Starts `holder` on `s` the way a controller start does: the start check at the epoch it read, then the compare-and-set take. */
const start = async (s: ControllerStorage, holder: string): Promise<number> => { const e = await s.currentEpoch(); await assertStartAllowed(s, holder, e); return (await s.acquireEpoch({ holder, at: T, expectedEpoch: e })).epoch; };

for (const backend of backends) {
  test(`${backend.name}: a backup made before a promotion, restored with the live authority carried, keeps the successor in charge; the old controller, and a successor of an earlier promotion, are refused (K05 second slice)`, async () => {
    const live = await backend.open();
    const dir = tmp();
    const opened: { close(): Promise<void> }[] = [];
    const fresh = async (): Promise<ControllerStorage> => { const w = await backend.open(); opened.push(w); return w.storage; };
    try {
      const s = live.storage;
      const blobs = await FileBlobStore.open({ directory: join(dir, "blobs") });
      const m = join(dir, "m");
      const eA = await start(s, "ctl-a");
      await put(s, eA, "before");
      // rows of other kinds on both sides of the record's kind, and another row of its kind ordered before it: none is taken for the record, and none hides it
      await put(s, eA, "zz", "aardvark");
      assert.equal((await liveSide(s)).authority, undefined, "no record yet: the rows around its key are not it");
      await put(s, eA, "aaa", "controller-authority");
      assert.equal((await liveSide(s)).authority, undefined);
      const backups = new BackupService(s, { root: join(dir, "b"), version: "t", now });
      const early = await backups.backUpNow("manual");
      await put(s, eA, "after");
      await writeFencedRecoveryManifest({ storage: s, epoch: eA, directory: m, now });
      await promoteController({ storage: s, manifestDirectory: m, blobs, successor: "ctl-b", promotionId: "p1", now });
      const eB = await start(s, "ctl-b");
      assert.equal((await liveSide(s)).authority?.["id"], "primary", "found past another row of its kind");
      const restoreWith = async (target: ControllerStorage, from: ControllerStorage, path: string, carry = true): Promise<void> => {
        const side = await liveSide(from);
        await restoreBackup(path, target, carry ? { carryAuthority: (b) => carryControllerAuthority(side, b) } : {});
      };

      // without the carry (as before this slice): the hole the second review found, shown on this backend
      const plain = await fresh();
      await restoreWith(plain, s, early.path, false);
      assert.equal(await readControllerAuthority(plain), undefined);
      await assertStartAllowed(plain, "ctl-a", await plain.currentEpoch());

      // with it: the live epoch, holder and record; the backup's data and nothing after it
      const r1 = await fresh();
      await restoreWith(r1, s, early.path);
      const st = await stateOf(r1);
      assert.equal(st?.["epoch"], eB); assert.equal(st?.["holder"], "ctl-b");
      assert.deepEqual(await readControllerAuthority(r1), await readControllerAuthority(s), "the record is the running store's, byte for byte");
      assert.ok(await r1.getAggregate({ kind: "note", id: "before" })); assert.equal(await r1.getAggregate({ kind: "note", id: "after" }), undefined);
      const backupState = JSON.parse(JSON.stringify(early.manifest)) as { files: { table: string; rows: number }[] };
      assert.equal(st?.["audit_seq"], backupState.files.find((f) => f.table === "audit")!.rows, "the backup's counters are kept");
      await assert.rejects(start(r1, "ctl-a"), /named ctl-b .*this controller starts as ctl-a/);
      await assert.rejects(start(r1, "ctl-x"), /may not use this store/);
      const eB2 = await start(r1, "ctl-b");
      assert.equal(eB2, eB + 1, "the successor's restart goes on from the live epoch, never back below it");
      await put(r1, eB2, "restored-work");

      // the same backup restored a second time, from the store the first restore made: still ctl-b's
      const r2 = await fresh();
      await restoreWith(r2, r1, early.path);
      assert.equal((await stateOf(r2))?.["epoch"], eB2);
      await assert.rejects(start(r2, "ctl-a"), /may not use this store/);
      await start(r2, "ctl-b");

      // a backup made after the first promotion (it holds p1's record), then a second promotion naming ctl-c: restoring either brings p2, not p1
      const mid = await new BackupService(s, { root: join(dir, "b2"), version: "t", now }).backUpNow("manual");
      await writeFencedRecoveryManifest({ storage: s, epoch: eB, directory: m, now });
      await promoteController({ storage: s, manifestDirectory: m, blobs, successor: "ctl-c", promotionId: "p2", now });
      const eC = await start(s, "ctl-c");
      for (const path of [early.path, mid.path]) {
        const r3 = await fresh();
        await restoreWith(r3, s, path);
        const rec = await readControllerAuthority(r3);
        assert.ok(rec !== undefined && rec !== "unreadable" && rec.promotionId === "p2" && rec.successor === "ctl-c", JSON.stringify(rec));
        assert.equal((await stateOf(r3))?.["epoch"], eC);
        for (const old of ["ctl-a", "ctl-b"]) await assert.rejects(start(r3, old), /may not use this store/, old);
        await start(r3, "ctl-c");
      }

      // the old controller went on on its own copy and restarted there past the live epoch: its newer backup holds no promotion, and restoring it is refused with the target unused
      const copy = await fresh();
      let eOld = 0;
      while (eOld <= eC) eOld = await start(copy, "ctl-a");
      await put(copy, eOld, "old-copy");
      const newer = await new BackupService(copy, { root: join(dir, "b3"), version: "t", now }).backUpNow("manual");
      const target = await fresh();
      await assert.rejects(restoreWith(target, s, newer.path), refusedCarry(/later epoch than the running database .*does not hold the controller promotion p2/));
      assert.equal(await target.currentEpoch(), 0, "the refused restore writes no state row");

      // second review: a running store without any promotion (the old copy, at eOld) still gives an older backup its epoch and holder, and a backup's record is not added
      for (const path of [early.path, mid.path]) {
        const r4 = await fresh();
        await restoreWith(r4, copy, path);
        const s4 = await stateOf(r4);
        assert.equal(s4?.["epoch"], eOld, "never an epoch lower than the running one"); assert.equal(s4?.["holder"], "ctl-a");
        assert.equal(await readControllerAuthority(r4), undefined);
      }
      // and a fresh installation (no promotion, epoch 1) restoring the newer backup takes the backup's epoch and holder as they are
      const freshLive = await fresh();
      await start(freshLive, "controller");
      const r5 = await fresh();
      await restoreWith(r5, freshLive, newer.path);
      const s5 = await stateOf(r5);
      assert.equal(s5?.["epoch"], eOld); assert.equal(s5?.["holder"], "ctl-a");

      // the live record damaged: the restore is refused and the empty target stays unused (epoch 0)
      const broken = await fresh();
      const side = await liveSide(s);
      await assert.rejects(restoreBackup(early.path, broken, { carryAuthority: (b) => carryControllerAuthority({ ...side, authority: { ...side.authority!, body: "{" } }, b) }), refusedCarry(/running database cannot be read/));
      assert.equal(await broken.currentEpoch(), 0, "the state row is never written by a refused restore");
    } finally {
      for (const w of opened) await w.close().catch(() => undefined);
      await live.close(); gone(dir);
    }
  });
}

test("the record is looked for among at most 1,000 rows of its kind: more is refused, never read as no record (K05 second slice)", async () => {
  const s = new MemoryStorage();
  const e = await start(s, "ctl-a");
  for (let i = 0; i < 1000; i += 100) {
    await s.applyOperation({ operationId: `many-${i}`, epoch: e, actor: "t", correlationId: `many-${i}`, at: T, changes: Array.from({ length: 100 }, (_, k) => ({ type: "create" as const, ref: { kind: "controller-authority", id: `a${String(i + k).padStart(4, "0")}` }, body: { v: 1 } })), audit: [], outbox: [], effects: [], timers: [], cancelTimers: [], completeDeliveries: [], completeTimers: [], settleEffects: [] });
  }
  await assert.rejects(liveSide(s), refusedCarry(/more than 1000 records of the controller authority kind/));
  // 999 before it: found on the last page read
  const t = new MemoryStorage();
  const et = await start(t, "ctl-a");
  for (let i = 0; i < 999; i += 37) {
    await t.applyOperation({ operationId: `m-${i}`, epoch: et, actor: "t", correlationId: `m-${i}`, at: T, changes: Array.from({ length: 37 }, (_, k) => ({ type: "create" as const, ref: { kind: "controller-authority", id: `a${String(i + k).padStart(4, "0")}` }, body: { v: 1 } })), audit: [], outbox: [], effects: [], timers: [], cancelTimers: [], completeDeliveries: [], completeTimers: [], settleEffects: [] });
  }
  await t.applyOperation({ operationId: "rec", epoch: et, actor: "t", correlationId: "rec", at: T, changes: [{ type: "create", ref: { kind: "controller-authority", id: "primary" }, body: JSON.parse(String(record()["body"])) }], audit: [], outbox: [], effects: [], timers: [], cancelTimers: [], completeDeliveries: [], completeTimers: [], settleEffects: [] });
  assert.equal((await liveSide(t)).authority?.["id"], "primary");
});

test("a staged restore records in its marker the epoch the carried authority was read at, and its staged database holds the live record; a controller that lost the store between preview and apply stages nothing (K05 second slice)", async () => {
  const dir = tmp();
  try {
    const s = new MemoryStorage();
    const blobs = await FileBlobStore.open({ directory: join(dir, "blobs") });
    const m = join(dir, "m");
    const eA = await start(s, "ctl-a");
    await put(s, eA, "before");
    const backups = new BackupService(s, { root: join(dir, "b"), version: "t", now });
    const made = await backups.backUpNow("manual");
    await writeFencedRecoveryManifest({ storage: s, epoch: eA, directory: m, now });
    await promoteController({ storage: s, manifestDirectory: m, blobs, successor: "ctl-b", promotionId: "p1", now });
    const eB = await start(s, "ctl-b");
    const data = join(dir, "data"); mkdirSync(data);
    const sqlitePath = join(data, "x.sqlite");
    const sr = new StagedRestore({ backups, root: join(dir, "b"), barrier: new MaintenanceBarrier(), sqlitePath, dataDirectory: data, storage: s, epoch: eB, now });
    const plan = await sr.preview(made.manifest.name);
    assert.ok(plan.warnings.some((w) => /record of the last controller promotion \(p1, naming ctl-b\) and the database's epoch are kept from the running database/.test(w)), plan.warnings.join("\n"));
    const done = await sr.apply(made.manifest.name, plan.token);
    assert.equal(done.pending.epoch, eB);
    const staged = await SqliteStorage.open({ path: done.pending.stagedDb });
    try {
      assert.equal((await stateOf(staged))?.["holder"], "ctl-b");
      assert.equal(await staged.currentEpoch(), eB);
      assert.deepEqual(await readControllerAuthority(staged), await readControllerAuthority(s));
    } finally { await staged.close(); }
    await sr.cancel();
    // re-check: a backup made at the running epoch (a tie) is not described as deciding; the running record is kept
    const same = await new BackupService(s, { root: join(dir, "b"), version: "t", now: () => new Date(Date.parse(T) + 60_000) }).backUpNow("manual");
    assert.equal(same.manifest.epoch, eB);
    const tie = await sr.preview(same.manifest.name);
    assert.ok(tie.warnings.some((w) => /are kept from the running database/.test(w)), tie.warnings.join("\n"));
    assert.equal(tie.warnings.some((w) => /later epoch/.test(w)), false, tie.warnings.join("\n"));

    // a live record damaged after the preview: the apply is refused in plain words, nothing staged or recorded; a new preview is refused the same way
    const t = new MemoryStorage();
    const eT = await start(t, "ctl-a");
    const tb = new BackupService(t, { root: join(dir, "tb"), version: "t", now });
    const tm = await tb.backUpNow("manual");
    const d2 = join(dir, "d2"); mkdirSync(d2);
    const sr2 = new StagedRestore({ backups: tb, root: join(dir, "tb"), barrier: new MaintenanceBarrier(), sqlitePath: join(d2, "y.sqlite"), dataDirectory: d2, storage: t, epoch: eT, now });
    const p2 = await sr2.preview(tm.manifest.name);
    assert.equal(p2.warnings.some((w) => /controller promotion/.test(w)), false, "without a record the plan says nothing of one");
    await t.applyOperation({ operationId: "bad", epoch: eT, actor: "t", correlationId: "bad", at: T, changes: [{ type: "create", ref: { kind: "controller-authority", id: "primary" }, body: { format: 9 } }], audit: [], outbox: [], effects: [], timers: [], cancelTimers: [], completeDeliveries: [], completeTimers: [], settleEffects: [] });
    const unreadable = (e: unknown): boolean => e instanceof DomainError && e.code === "invalid_transition" && /record of a controller promotion in the running database cannot be read/.test(e.message);
    await assert.rejects(sr2.apply(tm.manifest.name, p2.token), unreadable);
    await assert.rejects(sr2.preview(tm.manifest.name), unreadable);
    assert.equal(existsSync(join(d2, PENDING_FILE)), false);
    assert.equal(sr2.pending, undefined);
  } finally { gone(dir); }
});

test("a staged restore of a newer backup that lacks the running store's promotion stages nothing; a walk past its bound refuses the preview and the apply in plain words (K05 second slice, first review)", async () => {
  const dir = tmp();
  try {
    const s = new MemoryStorage();
    const blobs = await FileBlobStore.open({ directory: join(dir, "blobs") });
    const m = join(dir, "m");
    const eA = await start(s, "ctl-a");
    await put(s, eA, "before");
    await writeFencedRecoveryManifest({ storage: s, epoch: eA, directory: m, now });
    await promoteController({ storage: s, manifestDirectory: m, blobs, successor: "ctl-b", promotionId: "p1", now });
    const eB = await start(s, "ctl-b");
    // the old controller's own copy, restarted past the live epoch, backs up into the same folder
    const copy = new MemoryStorage();
    let eOld = 0;
    while (eOld <= eB) eOld = await start(copy, "ctl-a");
    await put(copy, eOld, "old-copy");
    const root = join(dir, "b");
    const made = await new BackupService(copy, { root, version: "t", now }).backUpNow("manual");
    const data = join(dir, "data"); mkdirSync(data);
    const sr = new StagedRestore({ backups: new BackupService(s, { root, version: "t", now }), root, barrier: new MaintenanceBarrier(), sqlitePath: join(data, "x.sqlite"), dataDirectory: data, storage: s, epoch: eB, now });
    const plan = await sr.preview(made.manifest.name);
    // second review: the preview says the backup's side decides and may be refused, not that the running record is kept
    assert.ok(plan.warnings.some((w) => new RegExp(`later epoch \\(${eOld}\\) than the running database \\(${eB}\\).*must hold the last controller promotion \\(p1, naming ctl-b\\) or a later one; otherwise the restore is refused`).test(w)), plan.warnings.join("\n"));
    assert.equal(plan.warnings.some((w) => /are kept from the running database/.test(w)), false, plan.warnings.join("\n"));
    const refused = (e: unknown): boolean => e instanceof DomainError && e.code === "invalid_transition" && /does not hold the controller promotion p1/.test(e.message);
    await assert.rejects(sr.apply(made.manifest.name, plan.token), refused);
    assert.deepEqual(readdirSync(data), [], "no staged database and no marker are left");
    assert.equal(sr.pending, undefined);
    assert.ok(await assertStartAllowed(s, "ctl-b", eB) === undefined);
    await assert.rejects(assertStartAllowed(s, "ctl-a", eB), /may not use this store/);

    // more than 1,000 rows of the record's kind: the preview and the apply are refused as a domain error, not an internal one
    const t = new MemoryStorage();
    const eT = await start(t, "ctl-a");
    const tb = new BackupService(t, { root: join(dir, "tb"), version: "t", now });
    const tm = await tb.backUpNow("manual");
    const d2 = join(dir, "d2"); mkdirSync(d2);
    const sr2 = new StagedRestore({ backups: tb, root: join(dir, "tb"), barrier: new MaintenanceBarrier(), sqlitePath: join(d2, "y.sqlite"), dataDirectory: d2, storage: t, epoch: eT, now });
    const p2 = await sr2.preview(tm.manifest.name);
    for (let i = 0; i < 1001; i += 77) {
      await t.applyOperation({ operationId: `many-${i}`, epoch: eT, actor: "t", correlationId: `many-${i}`, at: T, changes: Array.from({ length: Math.min(77, 1001 - i) }, (_, k) => ({ type: "create" as const, ref: { kind: "controller-authority", id: `a${String(i + k).padStart(4, "0")}` }, body: { v: 1 } })), audit: [], outbox: [], effects: [], timers: [], cancelTimers: [], completeDeliveries: [], completeTimers: [], settleEffects: [] });
    }
    const bound = (e: unknown): boolean => e instanceof DomainError && e.code === "invalid_transition" && /more than 1000 records of the controller authority kind/.test(e.message);
    await assert.rejects(sr2.apply(tm.manifest.name, p2.token), bound);
    await assert.rejects(sr2.preview(tm.manifest.name), bound);
    assert.deepEqual(readdirSync(d2), []);

    // the store taken by another controller between the preview and the apply: nothing is staged
    const u = new MemoryStorage();
    const eU = await start(u, "ctl-a");
    const ub = new BackupService(u, { root: join(dir, "ub"), version: "t", now });
    const um = await ub.backUpNow("manual");
    const d3 = join(dir, "d3"); mkdirSync(d3);
    const sr3 = new StagedRestore({ backups: ub, root: join(dir, "ub"), barrier: new MaintenanceBarrier(), sqlitePath: join(d3, "z.sqlite"), dataDirectory: d3, storage: u, epoch: eU, now });
    const p3 = await sr3.preview(um.manifest.name);
    await start(u, "ctl-z");
    await assert.rejects(sr3.apply(um.manifest.name, p3.token), (e: unknown) => e instanceof DomainError && e.code === "invalid_transition" && /no longer holds the database/.test(e.message));
    assert.deepEqual(readdirSync(d3), []);
    assert.equal(sr3.pending, undefined);
  } finally { gone(dir); }
});
