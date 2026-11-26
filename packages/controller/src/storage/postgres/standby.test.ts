import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { setTimeout as sleep } from "node:timers/promises";
import { ArtifactService, FileBlobStore } from "../../artifacts/index.js";
import { createBackup, restoreBackup, verifyBackup } from "../../backup/index.js";
import { PromotionRefused, measureLoss, parseStandbyConfig, promoteDatabase, snapshotSource, verifyStandbyInstallation, writeRecoveryManifest, type Acknowledged } from "../../recovery/index.js";
import { StorageError, isStorageError } from "../errors.js";
import { MemoryStorage } from "../memory.js";
import { SqliteStorage } from "../sqlite/index.js";
import { commitOperation } from "../commit.js";
import type { OperationInput } from "../types.js";
import { findWritablePrimary, measureLag, probeNode, promoteStandby, readControllerState } from "./replication.js";
import { PostgresStorage } from "./storage.js";
import { STANDBY_NAME, startReplicaPair, type ReplicaPair } from "./testing/replica.js";
import { withClient } from "./testing/server.js";

// Card K04 against a real PostgreSQL primary and a real streaming standby (two disposable embedded servers). The replication is PostgreSQL's own; these tests only ask it questions and promote.

const T0 = "2026-11-25T12:00:00.000Z";
const SCHEMA = "nimblenewt";
const mark = (id: string, epoch = 1): OperationInput => ({
  operationId: id, epoch, actor: "test", correlationId: `c-${id}`, at: T0, changes: [{ type: "create", ref: { kind: "marker", id }, body: { n: id } }], audit: [{ type: "marker.written", detail: { id } }],
  outbox: [], effects: [], timers: [], cancelTimers: [], completeDeliveries: [], completeTimers: [], settleEffects: [],
});
const tmp = (): string => mkdtempSync(join(tmpdir(), "nn-k04-"));
const gone = (d: string): void => rmSync(d, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
const openOn = (url: string, extra: Partial<Parameters<typeof PostgresStorage.open>[0]> = {}) => PostgresStorage.open({ connectionString: url, schema: SCHEMA, ...extra });
const file = (path: string, text: string) => ({ path, content: Buffer.from(text) });

/** Runs `body` with a started pair and removes it after, whatever happens. */
async function withPair(options: { synchronous?: boolean }, body: (pair: ReplicaPair) => Promise<void>): Promise<void> {
  const pair = await startReplicaPair(options);
  try { await body(pair); } finally { await pair.stop(); }
}

async function until<T>(what: string, read: () => Promise<T | undefined>, timeoutMs = 30_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const got = await read().catch(() => undefined);
    if (got !== undefined) return got;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await sleep(25);
  }
}

/** Writes markers one by one, recording when each was acknowledged. */
async function writeMarkers(storage: PostgresStorage, ids: readonly number[], acked: Acknowledged[]): Promise<void> {
  for (const n of ids) {
    await storage.applyOperation(mark(`m${n}`));
    acked.push({ seq: n, ackedAtMs: Date.now() });
    await sleep(5);
  }
}

async function markersOn(url: string): Promise<Set<number>> {
  const found = new Set<number>();
  for await (const r of readControllerState(url, SCHEMA).aggregates()) if (r.kind === "marker") found.add(Number(r.id.slice(1)));
  return found;
}

const noBlobs = { verify: async () => "ok" as const };

test("lag is measured from the primary: caught up reads zero, a standby that has received but not replayed shows it, a standby that is gone shows no link (card K04)", { timeout: 120_000 }, async () => {
  await withPair({}, async (pair) => {
    const storage = await openOn(pair.primary.url());
    try {
      await storage.acquireEpoch({ holder: "c1", at: T0 });
      await writeMarkers(storage, [1, 2, 3], []);
      await pair.waitForCatchUp();
      const caught = await until("a zero lag reading", async () => { const l = await measureLag(pair.primary.url(), STANDBY_NAME); return l !== undefined && l.unflushedBytes === 0 && l.unreplayedBytes === 0 ? l : undefined; });
      assert.equal(caught.syncState, "async");
      assert.equal(caught.state, "streaming");
      assert.equal(await measureLag(pair.primary.url(), "nobody"), undefined, "a standby the primary does not list has no measurement");

      // replay paused: the standby keeps receiving and flushing, but does not apply
      await withClient(pair.standby.url("postgres"), async (c) => { await c.query("SELECT pg_wal_replay_pause()"); });
      await writeMarkers(storage, [4, 5, 6, 7, 8], []);
      const behind = await until("flushed but unreplayed WAL", async () => { const l = await measureLag(pair.primary.url(), STANDBY_NAME); return l !== undefined && l.unflushedBytes === 0 && l.unreplayedBytes > 0 ? l : undefined; });
      assert.ok(behind.unreplayedBytes > 0 && behind.unflushedBytes === 0);
      const facts = await probeNode(pair.standby.url());
      assert.equal(facts.inRecovery, true);
      assert.equal(facts.writable, false);
      assert.notEqual(facts.receivedLsn, facts.positionLsn, "received ahead of replayed");
      assert.deepEqual([...await markersOn(pair.standby.url())].sort(), [1, 2, 3], "the paused standby shows only what it replayed");
      // a standby that has received more than it applied is not judged, and not promoted
      const dir = tmp();
      try {
        const src = snapshotSource(storage);
        try { await writeRecoveryManifest(src, join(dir, "m")); } finally { await src.close(); }
        await assert.rejects(promoteDatabase({ manifestDirectory: join(dir, "m"), standby: { url: pair.standby.url(), schema: SCHEMA }, blobs: noBlobs, replayWaitMs: 500 }), (e: unknown) => e instanceof PromotionRefused && /received WAL it has not replayed/.test(e.message));
        assert.equal((await probeNode(pair.standby.url())).inRecovery, true, "still a standby");
      } finally { gone(dir); }
      await withClient(pair.standby.url("postgres"), async (c) => { await c.query("SELECT pg_wal_replay_resume()"); });
      await until("replay to catch up", async () => { const l = await measureLag(pair.primary.url(), STANDBY_NAME); return l !== undefined && l.unreplayedBytes === 0 ? l : undefined; });
      assert.equal((await markersOn(pair.standby.url())).size, 8);

      pair.standby.stop("fast");
      await until("the link to disappear", async () => (await measureLag(pair.primary.url(), STANDBY_NAME)) === undefined ? true : undefined);
    } finally { await storage.close().catch(() => undefined); }
  });
});

test("asynchronous: writes acknowledged while the standby was behind are lost with the primary, and the loss is measured; the database is promoted and the controller is not (card K04)", { timeout: 180_000 }, async () => {
  await withPair({}, async (pair) => {
    const dir = tmp();
    const storage = await openOn(pair.primary.url());
    const acked: Acknowledged[] = [];
    try {
      await storage.acquireEpoch({ holder: "c1", at: T0 });
      await writeMarkers(storage, [1, 2, 3], acked);
      await pair.waitForCatchUp();
      const source = snapshotSource(storage);
      try { await writeRecoveryManifest(source, join(dir, "manifest")); } finally { await source.close(); }
      // the standby falls behind (it is stopped), the primary goes on acknowledging, then the primary is lost
      pair.standby.stop("fast");
      await writeMarkers(storage, [4, 5, 6], acked);
      pair.primary.stop("immediate");
      pair.standby.start();

      // the old handle is dead: its calls fail, they do not hang or pretend
      await assert.rejects(storage.applyOperation(mark("m7")), (e: unknown) => isStorageError(e, "retryable") || isStorageError(e, "uncertain_commit") || isStorageError(e, "unavailable"));

      const result = await promoteDatabase({ manifestDirectory: join(dir, "manifest"), standby: { url: pair.standby.url(), schema: SCHEMA }, blobs: noBlobs, oldPrimaryUrl: pair.primary.url(), replayWaitMs: 10_000 });
      assert.equal(result.database, "promoted");
      assert.equal(result.controller, "not_promoted");
      assert.match(result.notes.join(" "), /old primary did not answer.*partition/, "a stopped old primary is reported as not answering, not as proven gone");

      const loss = measureLoss(acked, await markersOn(pair.standby.url()));
      assert.deepEqual({ surviving: loss.surviving, lost: loss.lost, lostSeqs: loss.lostSeqs }, { surviving: 3, lost: 3, lostSeqs: [4, 5, 6] }, "asynchronous replication loses what the standby had not received");
      assert.ok(loss.windowMs > 0, `a loss window of ${loss.windowMs} ms`);

      // writable-primary reconnection: the old address is unreachable, the promoted node is the first writable one
      const found = await findWritablePrimary([pair.primary.url(), pair.standby.url()]);
      assert.equal(found.url, pair.standby.url());
      assert.deepEqual(found.found.map((f) => f.role), ["unreachable", "writable"]);
      const reopened = await openOn(found.url!);
      try {
        // database failover is not controller promotion: the epoch and holder are exactly as they were
        assert.equal(await reopened.currentEpoch(), 1);
        // taking the controller's epoch is its own, separate step; once taken, the old epoch is refused
        const taken = await reopened.acquireEpoch({ holder: "c2", at: T0, expectedEpoch: 1 });
        assert.equal(taken.epoch, 2);
        await assert.rejects(reopened.applyOperation(mark("late")), (e: unknown) => isStorageError(e, "stale_epoch"));
        // the lost writes are resubmitted by operation ID: each is admitted once, however often it is sent
        for (const n of [4, 5, 6]) {
          const first = await commitOperation(reopened, mark(`m${n}`, 2));
          assert.equal(first.replayed, false);
          assert.equal((await commitOperation(reopened, mark(`m${n}`, 2))).replayed, true);
        }
        assert.equal((await markersOn(found.url!)).size, 6);
      } finally { await reopened.close(); }
    } finally { await storage.close().catch(() => undefined); gone(dir); }
  });
});

test("synchronous: every acknowledged write survives losing the primary, and a commit that was not acknowledged is uncertain and is resolved once by operation ID (card K04)", { timeout: 180_000 }, async () => {
  await withPair({ synchronous: true }, async (pair) => {
    const dir = tmp();
    const storage = await openOn(pair.primary.url());
    const acked: Acknowledged[] = [];
    try {
      await storage.acquireEpoch({ holder: "c1", at: T0 });
      await writeMarkers(storage, [1, 2, 3], acked);
      const lag = await until("a synchronous link", async () => { const l = await measureLag(pair.primary.url(), STANDBY_NAME); return l?.syncState === "sync" ? l : undefined; });
      assert.equal(lag.unflushedBytes, 0, "with synchronous replication the standby has every acknowledged byte on disk");
      const source = snapshotSource(storage);
      try { await writeRecoveryManifest(source, join(dir, "manifest")); } finally { await source.close(); }

      // the standby goes away: the next commit waits for it and is never acknowledged
      pair.standby.stop("fast");
      const waiting = storage.applyOperation(mark("m4"));
      waiting.catch(() => undefined);
      await until("the commit to wait for the standby", async () => (await withClient(pair.primary.url("postgres"), async (c) => c.query("SELECT 1 FROM pg_stat_activity WHERE wait_event = 'SyncRep'"))).rowCount === 1 ? true : undefined);
      pair.primary.stop("immediate");
      await assert.rejects(waiting, (e: unknown) => isStorageError(e, "uncertain_commit"), "the outcome of a commit cut during the wait is unknown, not failed");
      pair.standby.start();

      await promoteDatabase({ manifestDirectory: join(dir, "manifest"), standby: { url: pair.standby.url(), schema: SCHEMA }, blobs: noBlobs, oldPrimaryUrl: pair.primary.url(), replayWaitMs: 10_000 });
      const loss = measureLoss(acked, await markersOn(pair.standby.url()));
      assert.deepEqual({ lost: loss.lost, windowMs: loss.windowMs }, { lost: 0, windowMs: 0 }, "no acknowledged write was lost");
      const reopened = await openOn(pair.standby.url());
      try {
        assert.equal(await reopened.getOperation("m4"), undefined, "the uncertain commit never reached the standby");
        const again = await commitOperation(reopened, mark("m4"), { });
        assert.equal(again.replayed, false);
        assert.equal((await commitOperation(reopened, mark("m4"))).replayed, true);
        assert.equal((await reopened.listAudit({ afterSeq: 0, limit: 100 })).filter((a) => a.type === "marker.written").length, 4, "admitted once");
      } finally { await reopened.close(); }
    } finally { await storage.close().catch(() => undefined); gone(dir); }
  });
});

test("synchronous: with the standby stopped a commit waits and is not answered, and it completes when the standby returns", { timeout: 120_000 }, async () => {
  await withPair({ synchronous: true }, async (pair) => {
    const storage = await openOn(pair.primary.url());
    try {
      await storage.acquireEpoch({ holder: "c1", at: T0 });
      await writeMarkers(storage, [1], []);
      pair.standby.stop("fast");
      let answered = false;
      const waiting = storage.applyOperation(mark("m2")).then(() => { answered = true; });
      await until("the commit to wait", async () => (await withClient(pair.primary.url("postgres"), async (c) => c.query("SELECT 1 FROM pg_stat_activity WHERE wait_event = 'SyncRep'"))).rowCount === 1 ? true : undefined);
      await sleep(300);
      assert.equal(answered, false, "no answer while no standby has it");
      pair.standby.start();
      await waiting;
      assert.equal(answered, true);
      await pair.waitForCatchUp();
      assert.deepEqual([...await markersOn(pair.standby.url())].sort(), [1, 2]);
    } finally { await storage.close().catch(() => undefined); }
  });
});

test("a standby missing an artifact file, or workflow state the manifest lists, is not promoted and stays a standby (card K04)", { timeout: 180_000 }, async () => {
  await withPair({}, async (pair) => {
    const dir = tmp();
    const primaryBlobs = await FileBlobStore.open({ directory: join(dir, "primary-blobs") });
    const standbyBlobs = await FileBlobStore.open({ directory: join(dir, "standby-blobs") });
    const storage = await openOn(pair.primary.url());
    try {
      const artifacts = await ArtifactService.open(storage, primaryBlobs, { holder: "c1", clock: () => T0, pause: async () => undefined });
      await artifacts.publish({ commandId: "pub-1", actor: "rob", name: "first", files: [file("a.txt", "alpha")] });
      await pair.waitForCatchUp();
      const source = snapshotSource(storage);
      try { await writeRecoveryManifest(source, join(dir, "manifest-1")); } finally { await source.close(); }
      pair.primary.stop("immediate");
      const options = { standby: { url: pair.standby.url(), schema: SCHEMA }, blobs: standbyBlobs, oldPrimaryUrl: pair.primary.url(), replayWaitMs: 5_000 };

      // the database has the record, the standby host does not have the file
      const stillStandby = async (): Promise<void> => { assert.equal((await probeNode(pair.standby.url())).inRecovery, true, "nothing was promoted"); };
      await assert.rejects(promoteDatabase({ ...options, manifestDirectory: join(dir, "manifest-1") }), (e: unknown) => e instanceof PromotionRefused && e.problems.some((p) => p.kind === "blob_missing") && /not on this node/.test(e.message));
      await stillStandby();
      // a file with the right name and the wrong bytes is no better
      const wrong = await FileBlobStore.open({ directory: join(dir, "wrong-blobs") });
      const digest = (await primaryBlobs.list())[0]!.digest;
      mkdirSync(dirname(wrong.pathOf(digest)), { recursive: true });
      writeFileSync(wrong.pathOf(digest), "x".repeat("alpha".length)); // the right name and size, the wrong bytes
      await assert.rejects(promoteDatabase({ ...options, blobs: wrong, manifestDirectory: join(dir, "manifest-1") }), (e: unknown) => e instanceof PromotionRefused && e.problems.some((p) => p.kind === "blob_corrupt") && /does not match its name/.test(e.message));
      await stillStandby();

      // workflow state the standby never received: the manifest is newer than the standby
      pair.primary.start();
      await pair.waitForStreaming();
      pair.standby.stop("fast");
      await artifacts.publish({ commandId: "pub-2", actor: "rob", name: "second", files: [file("b.txt", "bravo")] });
      const again = snapshotSource(storage);
      try { await writeRecoveryManifest(again, join(dir, "manifest-2")); } finally { await again.close(); }
      pair.primary.stop("immediate");
      pair.standby.start();
      for (const blob of await primaryBlobs.list()) await standbyBlobs.put(await (async () => primaryBlobs.read(blob.digest))());
      const refused = await promoteDatabase({ ...options, manifestDirectory: join(dir, "manifest-2") }).then(() => undefined, (e: unknown) => e);
      assert.ok(refused instanceof PromotionRefused, String(refused));
      assert.ok(refused.problems.some((p) => p.kind === "workflow_missing"), JSON.stringify(refused.problems));
      assert.ok(refused.problems.some((p) => p.kind === "audit_behind"));
      await stillStandby();
      assert.ok(digest.length === 64);

      // the first manifest, with its file now on the standby host, is whole: the promotion goes through
      const ok = await promoteDatabase({ ...options, manifestDirectory: join(dir, "manifest-1") });
      assert.equal(ok.comparison.lost.blobs, 0);
      assert.equal((await probeNode(pair.standby.url())).writable, true);
    } finally { await storage.close().catch(() => undefined); gone(dir); }
  });
});

test("a promotion is refused while the old primary still answers as a writable database, and for a node that is not a standby; the low-level call refuses a primary too (card K04)", { timeout: 120_000 }, async (t) => {
  await withPair({}, async (pair) => {
    const dir = tmp();
    try {
      const storage = await openOn(pair.primary.url());
      try { await storage.acquireEpoch({ holder: "c1", at: T0 }); await pair.waitForCatchUp(); const s = snapshotSource(storage); try { await writeRecoveryManifest(s, join(dir, "m")); } finally { await s.close(); } } finally { await storage.close(); }
      await assert.rejects(promoteDatabase({ manifestDirectory: join(dir, "m"), standby: { url: pair.standby.url(), schema: SCHEMA }, blobs: noBlobs, oldPrimaryUrl: pair.primary.url() }), (e: unknown) => e instanceof PromotionRefused && /still answers as a writable database/.test(e.message));
      assert.equal((await probeNode(pair.standby.url())).inRecovery, true, "the standby is as it was");
      await assert.rejects(promoteDatabase({ manifestDirectory: join(dir, "m"), standby: { url: pair.primary.url(), schema: SCHEMA }, blobs: noBlobs }), (e: unknown) => e instanceof PromotionRefused && /already a writable database/.test(e.message));
      await assert.rejects(promoteStandby(pair.primary.url()), (e: unknown) => e instanceof StorageError && /not a standby/.test(e.message));
      // a store opened on a standby can be read but never written: a write is refused by the server, never half-applied, which is why a controller picks its node with findWritablePrimary first
      const onStandby = await openOn(pair.standby.url(), { connectTimeoutMs: 3000 });
      try {
        assert.equal(await onStandby.currentEpoch(), 1);
        const refusal = await onStandby.applyOperation(mark("never")).then(() => undefined, (e: unknown) => e);
        assert.ok(refusal instanceof StorageError, String(refusal));
        t.diagnostic(`a write on a standby fails as ${refusal.kind}: ${refusal.message.slice(0, 100)}`);
      } finally { await onStandby.close(); }
      const found = await findWritablePrimary([pair.standby.url(), pair.primary.url()]);
      assert.equal(found.url, pair.primary.url());
      assert.deepEqual(found.found.map((f) => f.role), ["standby", "writable"]);
    } finally { gone(dir); }
  });
});

test("the installation check compares what is configured with what runs, in both modes", { timeout: 120_000 }, async () => {
  await withPair({}, async (pair) => {
    const cfg = (mode: "asynchronous" | "synchronous") => parseStandbyConfig({ name: STANDBY_NAME, mode, url: pair.standby.url(), manifestDirectory: "m", blobDirectory: "b" })!;
    const primaryUrl = pair.primary.url();
    const asyncOk = await verifyStandbyInstallation({ primaryUrl, standby: cfg("asynchronous") });
    assert.deepEqual(asyncOk.findings, []);
    assert.equal(asyncOk.actualSyncState, "async");
    const wantsSync = await verifyStandbyInstallation({ primaryUrl, standby: cfg("synchronous") });
    assert.equal(wantsSync.ok, false);
    assert.match(wantsSync.findings.join(" "), /commits do not wait for it/);
    assert.match(wantsSync.synchronousSetting, /FIRST 1 \(nn_standby\)/);
    await pair.setSynchronous([STANDBY_NAME]);
    await until("the synchronous state", async () => (await measureLag(primaryUrl, STANDBY_NAME))?.syncState === "sync" ? true : undefined);
    assert.equal((await verifyStandbyInstallation({ primaryUrl, standby: cfg("synchronous") })).ok, true);
    assert.match((await verifyStandbyInstallation({ primaryUrl, standby: cfg("asynchronous") })).findings.join(" "), /if it stops, writes stop/);
    // not a standby of this primary, and not connected
    const wrongNode = await verifyStandbyInstallation({ primaryUrl, standby: { ...cfg("synchronous"), url: primaryUrl } });
    assert.match(wrongNode.findings.join(" "), /not in recovery/);
    await pair.setSynchronous([]);
    pair.standby.stop("fast");
    await until("the link to go", async () => (await measureLag(primaryUrl, STANDBY_NAME)) === undefined ? true : undefined);
    const gone2 = await verifyStandbyInstallation({ primaryUrl, standby: cfg("asynchronous") });
    assert.equal(gone2.ok, false);
    assert.equal(JSON.stringify(gone2).includes("nn-test-password"), false, "no password in anything reported");
  });
});

test("backups stay independently restorable: a backup made beside a standby restores into another backend with the standby and the primary both gone (card K04)", { timeout: 180_000 }, async () => {
  await withPair({}, async (pair) => {
    const dir = tmp();
    const blobs = await FileBlobStore.open({ directory: join(dir, "blobs") });
    const storage = await openOn(pair.primary.url());
    try {
      const artifacts = await ArtifactService.open(storage, blobs, { holder: "c1", clock: () => T0, pause: async () => undefined });
      await artifacts.publish({ commandId: "pub-1", actor: "rob", name: "report", files: [file("a.txt", "alpha")] });
      await writeMarkers(storage, [1, 2], []);
      await pair.waitForCatchUp();
      const backup = await createBackup(storage, { root: join(dir, "backups"), kind: "manual", version: "0.0.0-test", now: () => new Date(T0), blobs });
      const source = snapshotSource(storage);
      let manifest;
      try { manifest = await writeRecoveryManifest(source, join(dir, "manifest")); } finally { await source.close(); }
      // the standby's own copy is promoted; then every server is gone
      await storage.close();
      pair.primary.stop("fast");
      await promoteDatabase({ manifestDirectory: join(dir, "manifest"), standby: { url: pair.standby.url(), schema: SCHEMA }, blobs, oldPrimaryUrl: pair.primary.url() });
      pair.standby.stop("fast");

      // nothing of the recovery manifest or the replication is in the backup folder or needed to restore it
      assert.deepEqual(readdirSync(backup.path).filter((f) => /recovery|standby|replica/i.test(f)), []);
      assert.equal((await verifyBackup(backup.path)).ok, true);
      for (const [name, target] of [["reference store", new MemoryStorage()], ["SQLite", await SqliteStorage.open({ path: join(dir, "restored.sqlite") })]] as const) {
        const restoredBlobs = await FileBlobStore.open({ directory: join(dir, `restored-${name.replace(/ /g, "-")}`) });
        try {
          await restoreBackup(backup.path, target, { blobs: restoredBlobs });
          assert.equal((await target.getAggregate({ kind: "marker", id: "m2" }))?.revision, 1, name);
          assert.equal((await restoredBlobs.list()).length, 1, name);
          const s = snapshotSource(target);
          try { assert.equal((await writeRecoveryManifest(s, join(dir, `m-${name.replace(/ /g, "-")}`))).blobs.sha256, manifest.blobs.sha256, `${name}: the same artifact files`); } finally { await s.close(); }
        } finally { await target.close(); }
      }
    } finally { await storage.close().catch(() => undefined); gone(dir); }
  });
});
