import assert from "node:assert/strict";
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { ArtifactService, FileBlobStore } from "../artifacts/index.js";
import { backends, stopServer } from "../domain/testing/backends.js";
import { controllerAuthorityLines } from "../status/status.js";
import { MemoryStorage, type ControllerStorage } from "../storage/index.js";
import { CONTROLLER_AUTHORITY, ControllerPromotionRefused, assertStartAllowed, promoteController, readControllerAuthority, writeFencedRecoveryManifest, RECOVERY_MANIFEST_FILE, RecoveryWriteRefused } from "./index.js";
import { fenceHolder, parseAuthority, parseFenceHolder } from "./controller.js";

// Card K05, first slice: controller promotion with the old controller fenced first. Two controllers on one store (the old primary still holding its handle while the promotion runs on another),
// on all four storage backends: the old one can never write again once the fence is taken, a returning old controller cannot start, and the decision never rests on a stale manifest.

after(stopServer);
const T = "2026-11-27T12:00:00.000Z";
const fast = { clock: () => T, pause: async () => undefined };
const file = (path: string, text: string) => ({ path, content: Buffer.from(text) });
let n = 0;
const cid = (label: string) => `${label}-${n++}`;
const tmp = (): string => mkdtempSync(join(tmpdir(), "nn-k05-"));
const gone = (d: string): void => rmSync(d, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
const now = () => new Date(T);
const refused = (fenced: boolean, pattern?: RegExp) => (e: unknown): boolean => {
  if (!(e instanceof ControllerPromotionRefused)) throw e;
  assert.equal(e.fenced, fenced, `fenced should be ${fenced}: ${e.message}`);
  if (pattern !== undefined) assert.match(e.message, pattern);
  return true;
};
const holderOf = async (s: ControllerStorage): Promise<string | null> => { const snap = await s.snapshot(); try { return ((await snap.read("state", { limit: 1 }))[0]?.["holder"] as string | null) ?? null; } finally { await snap.close(); } };
const stale = (e: unknown): boolean => /stale_epoch|no longer the primary/.test(String((e as { kind?: string })?.kind ?? "") + String((e as Error)?.message ?? ""));

for (const backend of backends) {
  test(`${backend.name}: the old primary is fenced before the successor is named; after the fence it cannot write, deliver or write a manifest, and only the successor may start`, async () => {
    const world = await backend.open();
    const dir = tmp();
    try {
      const blobsA = await FileBlobStore.open({ directory: join(dir, "blobs-a") });
      const a = await ArtifactService.open(world.storage, blobsA, { holder: "ctl-a", ...fast });
      await a.publish({ commandId: cid("pub"), actor: "rob", name: "report", files: [file("a.txt", "alpha")] });
      const epochA = await world.storage.currentEpoch();
      const m = join(dir, "m");
      await writeFencedRecoveryManifest({ storage: world.storage, epoch: epochA, directory: m, now });
      cpSync(join(dir, "blobs-a"), join(dir, "blobs-b"), { recursive: true, force: false, errorOnExist: false });
      const blobsB = await FileBlobStore.open({ directory: join(dir, "blobs-b") });

      // before: the old controller writes, and every start is allowed (no promotion yet)
      await assertStartAllowed(world.storage, "ctl-a", epochA);
      await assertStartAllowed(world.storage, "anyone", epochA);
      assert.equal(await readControllerAuthority(world.storage), undefined);

      // a successor whose artifact store lacks a file the folder's manifest lists is refused before the fence, nothing changed
      const empty = await FileBlobStore.open({ directory: join(dir, "blobs-empty") });
      await assert.rejects(promoteController({ storage: world.storage, manifestDirectory: m, blobs: empty, successor: "ctl-b", now }), refused(false, /before the fence: .*is not on this node/));
      assert.equal(await world.storage.currentEpoch(), epochA);
      assert.equal(await holderOf(world.storage), "ctl-a");
      // a successor with the old controller's own name is refused, nothing changed
      await assert.rejects(promoteController({ storage: world.storage, manifestDirectory: m, blobs: blobsB, successor: "ctl-a", now }), refused(false, /own holder name/));
      assert.equal(await world.storage.currentEpoch(), epochA);

      const result = await promoteController({ storage: world.storage, manifestDirectory: m, blobs: blobsB, successor: "ctl-b", promotionId: "p1", now });
      assert.equal(result.controller, "promoted");
      assert.equal(result.fencedEpoch, epochA);
      assert.equal(result.fencedHolder, "ctl-a");
      assert.equal(result.fenceEpoch, epochA + 1);
      assert.equal(await world.storage.currentEpoch(), epochA + 1);
      assert.equal(await holderOf(world.storage), fenceHolder("p1", epochA));
      assert.equal(result.manifest.epoch, epochA + 1, "the decision was made on a manifest written after the fence");
      assert.equal(result.manifest.blobs, 1);
      assert.equal(JSON.parse(readFileSync(join(m, RECOVERY_MANIFEST_FILE), "utf8")).watermark.epoch, epochA + 1, "the fresh manifest replaced the old controller's");

      // the fence came first: the audit trail says fenced, then promoted, both at the fence epoch
      const audit = (await world.storage.listAudit({ afterSeq: 0, limit: 1000 })).filter((r) => r.type.startsWith("controller."));
      assert.deepEqual(audit.map((r) => r.type), ["controller.fenced", "controller.promoted"]);
      const record = await readControllerAuthority(world.storage);
      assert.ok(record !== undefined && record !== "unreadable");
      assert.equal(record.state, "promoted");
      assert.equal(record.successor, "ctl-b");

      // the old controller, still holding its handle, can no longer write anything
      await assert.rejects(a.publish({ commandId: cid("late"), actor: "rob", name: "late", files: [file("b.txt", "beta")] }), stale);
      await assert.rejects(world.storage.claimDeliveries({ epoch: epochA, destination: "x", claimant: "ctl-a", now: T, leaseMs: 1000, limit: 1 }), stale);
      await assert.rejects(world.storage.claimDueTimers({ epoch: epochA, claimant: "ctl-a", now: T, leaseMs: 1000, limit: 1 }), stale);
      await assert.rejects(writeFencedRecoveryManifest({ storage: world.storage, epoch: epochA, directory: m }), (e: unknown) => e instanceof RecoveryWriteRefused && e.reason === "stale_epoch");
      // nor take the store back at its old epoch
      await assert.rejects(world.storage.acquireEpoch({ holder: "ctl-a", at: T, expectedEpoch: epochA }), stale);

      // a returning old controller, or any other name, is refused at start; the successor is allowed
      const fence = await world.storage.currentEpoch();
      await assert.rejects(assertStartAllowed(world.storage, "ctl-a", fence), /named ctl-b .*fenced the controller of epoch \d+ \(ctl-a\); this controller starts as ctl-a/);
      await assert.rejects(assertStartAllowed(world.storage, "controller", fence), /may not use this store/);
      await assertStartAllowed(world.storage, "ctl-b", fence);
      // the start's check is at the epoch the start read: a moved epoch is refused
      await assert.rejects(assertStartAllowed(world.storage, "ctl-b", fence - 1), /epoch moved/);

      // the successor takes the epoch from the fence (as the start does) and writes; the old one stays out after the successor has started too
      const b = await ArtifactService.open(world.storage, blobsB, { holder: "ctl-b", ...fast });
      await b.publish({ commandId: cid("pub-b"), actor: "rob", name: "after", files: [file("c.txt", "gamma")] });
      const epochB = await world.storage.currentEpoch();
      await assert.rejects(assertStartAllowed(world.storage, "ctl-a", epochB), /may not use this store/);
      await assertStartAllowed(world.storage, "ctl-b", epochB);
      await assert.rejects(a.publish({ commandId: cid("later"), actor: "rob", name: "later", files: [file("d.txt", "delta")] }), stale);

      // the owner's lines say what happened, with no path
      const lines = controllerAuthorityLines(record, { kind: "installation", id: "installation" } as never).map((l) => (l as { text: string }).text).join("\n");
      assert.match(lines, /fenced the controller of epoch \d+ \(ctl-a\) at epoch \d+ and then named ctl-b/);
      assert.match(lines, /written after the fence/);
      assert.doesNotMatch(lines, new RegExp(dir.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
    } finally { await world.close(); gone(dir); }
  });

  test(`${backend.name}: a stale manifest is refused with nothing changed; work written after the folder's manifest is checked on a manifest made after the fence`, async () => {
    const world = await backend.open();
    const dir = tmp();
    try {
      const blobsA = await FileBlobStore.open({ directory: join(dir, "blobs-a") });
      const a1 = await ArtifactService.open(world.storage, blobsA, { holder: "ctl-a", ...fast });
      await a1.publish({ commandId: cid("pub"), actor: "rob", name: "one", files: [file("a.txt", "alpha")] });
      const m = join(dir, "m");
      await writeFencedRecoveryManifest({ storage: world.storage, epoch: await world.storage.currentEpoch(), directory: m, now });
      const blobsB = await FileBlobStore.open({ directory: join(dir, "blobs-b") });
      cpSync(join(dir, "blobs-a"), join(dir, "blobs-b"), { recursive: true, force: false, errorOnExist: false });

      // the controller restarts (a new epoch) and dies before its first manifest: the folder's manifest is of an earlier epoch
      const a2 = await ArtifactService.open(world.storage, blobsA, { holder: "ctl-a", ...fast });
      const epoch = await world.storage.currentEpoch();
      const before = readFileSync(join(m, RECOVERY_MANIFEST_FILE), "utf8");
      await assert.rejects(promoteController({ storage: world.storage, manifestDirectory: m, blobs: blobsB, successor: "ctl-b", now }), refused(false, /stale: it was written under epoch \d+, and the controller being replaced holds epoch \d+/));
      assert.equal(await world.storage.currentEpoch(), epoch, "nothing was fenced");
      assert.equal(await holderOf(world.storage), "ctl-a");
      assert.equal(await readControllerAuthority(world.storage), undefined);
      assert.equal(readFileSync(join(m, RECOVERY_MANIFEST_FILE), "utf8"), before, "the folder is untouched");
      await a2.publish({ commandId: cid("still"), actor: "rob", name: "still-primary", files: [file("s.txt", "still")] });
      cpSync(join(dir, "blobs-a"), join(dir, "blobs-b"), { recursive: true, force: false, errorOnExist: false });

      // a manifest of this epoch, then more work after it (a file the successor does not have): the folder's manifest passes, the one made after the fence does not
      await writeFencedRecoveryManifest({ storage: world.storage, epoch, directory: m, now });
      await a2.publish({ commandId: cid("late"), actor: "rob", name: "after-manifest", files: [file("z.txt", "zeta")] });
      await assert.rejects(promoteController({ storage: world.storage, manifestDirectory: m, blobs: blobsB, successor: "ctl-b", promotionId: "p2", now }), (e: unknown) => {
        refused(true, /after the fence: .*artifact file [0-9a-f]{12}\.\.\. is not on this node/)(e);
        assert.equal((e as ControllerPromotionRefused).problems[0]?.kind, "blob_missing");
        return true;
      });
      // fenced, nobody named: the old controller cannot write, and no controller may start, the intended successor included
      const fence = await world.storage.currentEpoch();
      assert.equal(fence, epoch + 1);
      await assert.rejects(a2.publish({ commandId: cid("x"), actor: "rob", name: "x", files: [file("x.txt", "x")] }), stale);
      for (const who of ["ctl-a", "ctl-b", "controller"]) await assert.rejects(assertStartAllowed(world.storage, who, fence), /has not named a successor .*artifact file/);
      const record = await readControllerAuthority(world.storage);
      assert.ok(record !== undefined && record !== "unreadable" && record.state === "fenced");
      assert.match(controllerAuthorityLines(record, { kind: "installation", id: "installation" } as never).map((l) => (l as { text: string }).text).join(" "), /did not name a successor, so no controller may start/);

      // the missing file is copied; the promotion run again goes through and still names the controller the first fence replaced
      cpSync(join(dir, "blobs-a"), join(dir, "blobs-b"), { recursive: true, force: false, errorOnExist: false });
      const again = await promoteController({ storage: world.storage, manifestDirectory: m, blobs: blobsB, successor: "ctl-b", promotionId: "p3", now });
      assert.equal(again.fencedEpoch, epoch, "the replaced epoch is the old controller's, not the earlier fence's");
      assert.equal(again.fencedHolder, "ctl-a");
      assert.equal(again.fenceEpoch, fence + 1);
      await assertStartAllowed(world.storage, "ctl-b", fence + 1);
      await assert.rejects(assertStartAllowed(world.storage, "ctl-a", fence + 1), /may not use this store/);
    } finally { await world.close(); gone(dir); }
  });

  test(`${backend.name}: a controller that starts between the checks and the fence wins and nothing is fenced; a lost answer after the fence committed goes on as fenced; a record that cannot be written leaves the fence`, async () => {
    const world = await backend.open();
    const dir = tmp();
    try {
      const blobs = await FileBlobStore.open({ directory: join(dir, "blobs") });
      await ArtifactService.open(world.storage, blobs, { holder: "ctl-a", ...fast });
      const m = join(dir, "m");
      const e0 = await world.storage.currentEpoch();
      await writeFencedRecoveryManifest({ storage: world.storage, epoch: e0, directory: m, now });
      // 1. the epoch moves just before the fence
      const racing = new Proxy(world.storage, { get(t, k) {
        if (k === "acquireEpoch") return async (input: Parameters<ControllerStorage["acquireEpoch"]>[0]) => { await t.acquireEpoch({ holder: "ctl-a", at: T }); return t.acquireEpoch(input); };
        const v = Reflect.get(t, k, t) as unknown; return typeof v === "function" ? (v as (...a: unknown[]) => unknown).bind(t) : v;
      } });
      await assert.rejects(promoteController({ storage: racing, manifestDirectory: m, blobs, successor: "ctl-b", now }), refused(false, /epoch moved while it was checked/));
      assert.equal(await holderOf(world.storage), "ctl-a", "the controller that started holds the store");
      assert.equal(await readControllerAuthority(world.storage), undefined);

      // 2. the fence commits and its answer is lost: the holder says it was taken, and the promotion goes on
      const e1 = await world.storage.currentEpoch();
      await writeFencedRecoveryManifest({ storage: world.storage, epoch: e1, directory: m, now });
      const lost = new Proxy(world.storage, { get(t, k) {
        if (k === "acquireEpoch") return async (input: Parameters<ControllerStorage["acquireEpoch"]>[0]) => { await t.acquireEpoch(input); throw Object.assign(new Error("connection reset /secret/path"), { code: "ECONNRESET" }); };
        const v = Reflect.get(t, k, t) as unknown; return typeof v === "function" ? (v as (...a: unknown[]) => unknown).bind(t) : v;
      } });
      const r = await promoteController({ storage: lost, manifestDirectory: m, blobs, successor: "ctl-b", promotionId: "lost", now });
      assert.equal(r.fenceEpoch, e1 + 1);

      // 3. a new controller (ctl-b) runs; a promotion to ctl-c whose record write fails stays fenced by its holder, and no one may start; run again, it goes through
      await ArtifactService.open(world.storage, blobs, { holder: "ctl-b", ...fast });
      const e2 = await world.storage.currentEpoch();
      await writeFencedRecoveryManifest({ storage: world.storage, epoch: e2, directory: m, now });
      const noRecord = new Proxy(world.storage, { get(t, k) {
        if (k === "applyOperation") return async () => { throw Object.assign(new Error("disk full at /secret/path"), { code: "SQLITE_FULL" }); };
        const v = Reflect.get(t, k, t) as unknown; return typeof v === "function" ? (v as (...a: unknown[]) => unknown).bind(t) : v;
      } });
      await assert.rejects(promoteController({ storage: noRecord, manifestDirectory: m, blobs, successor: "ctl-c", promotionId: "crash", now }), (e: unknown) => {
        refused(true, /record of the fence could not be written \(SQLITE_FULL\)/)(e);
        assert.doesNotMatch((e as Error).message, /secret/);
        return true;
      });
      assert.equal(await holderOf(world.storage), fenceHolder("crash", e2));
      for (const who of ["ctl-b", "ctl-c"]) await assert.rejects(assertStartAllowed(world.storage, who, e2 + 1), /has not named a successor/);
      const done = await promoteController({ storage: world.storage, manifestDirectory: m, blobs, successor: "ctl-c", promotionId: "redo", now });
      assert.equal(done.fencedEpoch, e2, "read from the fence holder");
      assert.equal(done.fencedHolder, null, "the name was not recorded by the promotion that stopped");
      await assertStartAllowed(world.storage, "ctl-c", e2 + 2);
      await assert.rejects(assertStartAllowed(world.storage, "ctl-b", e2 + 2), /may not use this store/);
    } finally { await world.close(); gone(dir); }
  });
}

test("refusals with nothing changed: no controller yet, a database transfer's holder, a manifest of a later epoch, bad names and folders, an unreadable record; and no option skips the fence", async () => {
  const dir = tmp();
  try {
    const blobs = await FileBlobStore.open({ directory: join(dir, "blobs") });
    const m = join(dir, "m");
    const fresh = new MemoryStorage();
    await assert.rejects(promoteController({ storage: fresh, manifestDirectory: m, blobs, successor: "b", now }), refused(false, /no controller has ever used this store/));

    const s = new MemoryStorage();
    await s.acquireEpoch({ holder: "ctl-a", at: T });
    await writeFencedRecoveryManifest({ storage: s, epoch: 1, directory: m, now });
    for (const successor of ["", "promotion-fence:x:1", "transferred-out:x", "a b", "x".repeat(81), "../x", 7 as unknown as string]) {
      await assert.rejects(promoteController({ storage: s, manifestDirectory: m, blobs, successor, now }), refused(false, /successor:/));
    }
    await assert.rejects(promoteController({ storage: s, manifestDirectory: "relative/m", blobs, successor: "b", now }), refused(false, /absolute path/));
    await assert.rejects(promoteController({ storage: s, manifestDirectory: m, blobs: {} as never, successor: "b", now }), refused(false, /blobs/));
    await assert.rejects(promoteController({ storage: s, manifestDirectory: m, blobs, successor: "b", promotionId: "bad id!", now }), refused(false, /promotionId/));
    await assert.rejects(promoteController({ storage: s, manifestDirectory: join(dir, "none"), blobs, successor: "b", now }), refused(false));
    // a manifest with a later epoch than the store: the store is an older copy
    const later = new MemoryStorage();
    for (let i = 0; i < 3; i++) await later.acquireEpoch({ holder: "ctl-a", at: T });
    const m3 = join(dir, "m3");
    await writeFencedRecoveryManifest({ storage: later, epoch: 3, directory: m3, now });
    await assert.rejects(promoteController({ storage: s, manifestDirectory: m3, blobs, successor: "b", now }), refused(false, /later than this store's epoch 1: this store is an older copy/));
    // a damaged manifest
    const text = readFileSync(join(m, RECOVERY_MANIFEST_FILE), "utf8");
    writeFileSync(join(m, RECOVERY_MANIFEST_FILE), text.replace('"epoch": 1', '"epoch": 2'));
    await assert.rejects(promoteController({ storage: s, manifestDirectory: m, blobs, successor: "b", now }), refused(false, /checksum/));
    writeFileSync(join(m, RECOVERY_MANIFEST_FILE), text);
    assert.equal(await s.currentEpoch(), 1, "none of these changed the store");

    // a store a database transfer fenced
    const t = new MemoryStorage();
    await t.acquireEpoch({ holder: "ctl-a", at: T });
    await t.acquireEpoch({ holder: "transferred-out:x1", at: T });
    await assert.rejects(promoteController({ storage: t, manifestDirectory: m, blobs, successor: "b", now }), refused(false, /database transfer holds this store/));
    // an unreadable record: refused for a promotion and for every start
    const u = new MemoryStorage();
    await u.acquireEpoch({ holder: "ctl-a", at: T });
    await u.applyOperation({ operationId: "bad-record", epoch: 1, actor: "x", correlationId: "x", at: T, changes: [{ type: "create", ref: CONTROLLER_AUTHORITY, body: { format: 9 } }], audit: [], outbox: [], effects: [], timers: [], cancelTimers: [], completeDeliveries: [], completeTimers: [], settleEffects: [] });
    await writeFencedRecoveryManifest({ storage: u, epoch: 1, directory: join(dir, "mu"), now });
    await assert.rejects(promoteController({ storage: u, manifestDirectory: join(dir, "mu"), blobs, successor: "b", now }), refused(false, /earlier controller promotion cannot be read/));
    await assert.rejects(assertStartAllowed(u, "ctl-a", 1), /cannot be read/);
    // a fence holder that does not read is never taken as a successor's go-ahead
    const f = new MemoryStorage();
    await f.acquireEpoch({ holder: "promotion-fence:garbage", at: T });
    await assert.rejects(assertStartAllowed(f, "ctl-a", 1), /promotion fence that cannot be read/);
    await assert.rejects(promoteController({ storage: f, manifestDirectory: m, blobs, successor: "b", now }), refused(false, /promotion fence that cannot be read/));

    // a promotion stopped after the fence (a file the successor lacks), then an epoch taken over the fence without looking (no compare-and-set, not something the product does): still nobody is readmitted
    const h = new MemoryStorage();
    const blobsH = await FileBlobStore.open({ directory: join(dir, "blobs-h") });
    const art = await ArtifactService.open(h, blobsH, { holder: "ctl-a", ...fast });
    const mh = join(dir, "mh");
    await writeFencedRecoveryManifest({ storage: h, epoch: 1, directory: mh, now });
    await art.publish({ commandId: cid("h"), actor: "rob", name: "h", files: [file("h.txt", "eta")] });
    await assert.rejects(promoteController({ storage: h, manifestDirectory: mh, blobs, successor: "b", now }), refused(true));
    const raw = await h.acquireEpoch({ holder: "ctl-a", at: T });
    await assert.rejects(assertStartAllowed(h, "ctl-a", raw.epoch), /fenced this store and did not finish/);
    await assert.rejects(assertStartAllowed(h, "b", raw.epoch), /fenced this store and did not finish/);

    // extra options a caller might hope for change nothing: the fence is always taken first
    const g = new MemoryStorage();
    await g.acquireEpoch({ holder: "ctl-a", at: T });
    const mg = join(dir, "mg");
    await writeFencedRecoveryManifest({ storage: g, epoch: 1, directory: mg, now });
    const r = await promoteController({ storage: g, manifestDirectory: mg, blobs, successor: "b", now, force: true, skipFence: true, consent: "owner" } as never);
    assert.equal(r.fenceEpoch, 2);
    const audit = await g.listAudit({ afterSeq: 0, limit: 10 });
    assert.deepEqual(audit.map((x) => x.type), ["controller.fenced", "controller.promoted"]);
  } finally { gone(dir); }
});

test("the fence holder and the record are read strictly", () => {
  assert.deepEqual(parseFenceHolder(fenceHolder("p1", 7)), { promotionId: "p1", fencedEpoch: 7 });
  for (const h of [null, undefined, "", "controller", "promotion-fence:", "promotion-fence:p1", "promotion-fence:p1:0", "promotion-fence:p1:-1", "promotion-fence:p1:1.5", "promotion-fence:p 1:3", "promotion-fence:p1:99999999999999999", "promotion-fence::3", "promotion-fence:p1:3:4"]) {
    assert.equal(parseFenceHolder(h), undefined, String(h));
  }
  const agg = (body: Record<string, unknown>) => ({ kind: "controller-authority", id: "primary", revision: 1, body, createdAt: T, updatedAt: T }) as never;
  const good = { format: 1, promotionId: "p", state: "promoted", successor: "b", fencedEpoch: 1, fencedHolder: "a", fenceEpoch: 2, at: T };
  assert.equal(parseAuthority(undefined), undefined);
  assert.deepEqual(parseAuthority(agg(good)), good);
  for (const bad of [{ ...good, format: 2 }, { ...good, state: "active" }, { ...good, successor: "a b" }, { ...good, fencedEpoch: -1 }, { ...good, fenceEpoch: "2" }, { ...good, fencedHolder: 3 }, { ...good, at: 1 }, { ...good, promotionId: undefined }]) {
    assert.equal(parseAuthority(agg(bad)), "unreadable", JSON.stringify(bad));
  }
});
