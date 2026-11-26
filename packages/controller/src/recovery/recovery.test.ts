import assert from "node:assert/strict";
import { readFileSync, readdirSync, rmSync, mkdtempSync, writeFileSync, unlinkSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { ArtifactService, FileBlobStore } from "../artifacts/index.js";
import { createBackup, restoreBackup } from "../backup/index.js";
import { backends, stopServer } from "../domain/testing/backends.js";
import type { PostgresStorage } from "../storage/index.js";
import { createHash } from "node:crypto";
import { canonicalJson } from "../storage/index.js";
import { promoteDatabaseWith } from "./promotion.js";
import * as recoveryIndex from "./index.js";
import {
  PromotionRefused, RecoveryManifestBad, StandbyConfigBad, compareToManifest, describeMode, measureLoss, parseStandbyConfig, promoteDatabase, readRecoveryManifest, reportRestoredStore,
  snapshotSource, writeRecoveryManifest, type RecoverySource,
} from "./index.js";

// Card K04: the recovery manifest, the comparison that decides whether a promotion is safe, the loss measurement and the optional capability, on all four storage backends where a store is
// involved. The real two-server replication tests are in storage/postgres/standby.test.ts.

after(stopServer);
const T = "2026-11-25T10:00:00.000Z";
const fast = { clock: () => T, pause: async () => undefined };
const file = (path: string, text: string) => ({ path, content: Buffer.from(text) });
let n = 0;
const cid = (label: string) => `${label}-${n++}`;
const tmp = (): string => mkdtempSync(join(tmpdir(), "nn-k04-"));
const gone = (d: string): void => rmSync(d, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
const digestsAcrossBackends: string[] = [];

for (const backend of backends) {
  test(`${backend.name}: the manifest lists every record and artifact file; a store compared with its own manifest has nothing missing, and each kind of loss is named`, async () => {
    const world = await backend.open();
    const dir = tmp();
    const blobs = await FileBlobStore.open({ directory: join(dir, "blobs") });
    try {
      const artifacts = await ArtifactService.open(world.storage, blobs, { holder: "c1", ...fast });
      await artifacts.publish({ commandId: "pub-A", actor: "rob", name: "report", files: [file("a.txt", "alpha"), file("b.txt", "bravo")] });
      const source = snapshotSource(world.storage);
      let manifest;
      try { manifest = await writeRecoveryManifest(source, join(dir, "manifest"), { now: () => new Date(T) }); } finally { await source.close(); }
      digestsAcrossBackends.push(manifest.aggregates.sha256);
      assert.equal(manifest.aggregates.rows, 1, "one artifact record");
      assert.equal(manifest.blobs.rows, 2);
      assert.equal(manifest.watermark.epoch, 1);
      assert.ok(manifest.watermark.auditSeq >= 1);
      assert.deepEqual(readdirSync(join(dir, "manifest")).sort(), ["aggregates.jsonl", "blobs.jsonl", "manifest.json"], "no partial folder is left");
      const read = readRecoveryManifest(join(dir, "manifest"));
      assert.equal(read.blobRefs().length, 2);

      const again = snapshotSource(world.storage);
      try {
        const clean = await compareToManifest(read, again, blobs);
        assert.deepEqual(clean.problems, []);
        assert.deepEqual(clean.lost, { auditEntries: 0, deliveries: 0, records: 0, staleRecords: 0, blobs: 0 });
        assert.deepEqual(clean.checked, { records: 1, blobs: 2 });

        // a later write makes the store newer than the manifest: not a problem
        await artifacts.publish({ commandId: cid("pub"), actor: "rob", name: "later", files: [file("c.txt", "charlie")] });
      } finally { await again.close(); }
      const newer = snapshotSource(world.storage);
      try { assert.deepEqual((await compareToManifest(read, newer, blobs)).problems, [], "a store ahead of the manifest is fine"); } finally { await newer.close(); }

      // a blob gone, a blob with the wrong bytes, no artifact store at all
      const [first, second] = read.blobRefs();
      assert.equal(await blobs.remove(first!.digest), true);
      unlinkSync(blobs.pathOf(second!.digest)); writeFileSync(blobs.pathOf(second!.digest), "x".repeat(second!.size)); // the right size, the wrong bytes
      const damaged = snapshotSource(world.storage);
      try {
        const c = await compareToManifest(read, damaged, blobs);
        assert.deepEqual(c.problems.map((p) => p.kind).sort(), ["blob_corrupt", "blob_missing"]);
        assert.equal(c.lost.blobs, 2);
        const none = await compareToManifest(read, damaged, undefined);
        assert.equal(none.problems.filter((p) => p.kind === "blob_missing").length, 2, "no artifact store on the node means every blob is missing");
        unlinkSync(blobs.pathOf(second!.digest)); writeFileSync(blobs.pathOf(second!.digest), "tiny"); // a different size
        assert.deepEqual((await compareToManifest(read, damaged, blobs)).problems.map((p) => p.kind).sort(), ["blob_missing", "blob_size_mismatch"]);
      } finally { await damaged.close(); }
    } finally { await world.close(); gone(dir); }
  });
}

test("the same writes give the same manifest on the reference store, SQLite, SQLite on a worker thread and PostgreSQL", () => {
  assert.equal(digestsAcrossBackends.length, 4);
  assert.equal(new Set(digestsAcrossBackends).size, 1, digestsAcrossBackends.join(" "));
});

for (const backend of backends) {
  test(`${backend.name}: a restore from a backup (the SQLite recovery path) is measured against the manifest written before the loss`, async () => {
    const live = await backend.open(); const fresh = await backend.open();
    const dir = tmp();
    const blobs = await FileBlobStore.open({ directory: join(dir, "blobs") });
    const restoredBlobs = await FileBlobStore.open({ directory: join(dir, "restored-blobs") });
    try {
      const artifacts = await ArtifactService.open(live.storage, blobs, { holder: "c1", ...fast });
      await artifacts.publish({ commandId: cid("pub"), actor: "rob", name: "one", files: [file("a.txt", "alpha")] });
      const backup = await createBackup(live.storage, { root: join(dir, "backups"), kind: "manual", version: "0.0.0-test", now: () => new Date(T), blobs });
      // work after the backup: it is what the restore will not have
      await artifacts.publish({ commandId: cid("pub"), actor: "rob", name: "two", files: [file("b.txt", "bravo")] });
      const source = snapshotSource(live.storage);
      try { await writeRecoveryManifest(source, join(dir, "manifest")); } finally { await source.close(); }

      await restoreBackup(backup.path, fresh.storage, { blobs: restoredBlobs });
      const report = await reportRestoredStore({ manifestDirectory: join(dir, "manifest"), storage: fresh.storage, blobs: restoredBlobs });
      assert.equal(report.complete, false);
      assert.equal(report.comparison.lost.records, 1, "the second artifact's record");
      assert.equal(report.comparison.lost.blobs, 1, "and its file");
      assert.ok(report.comparison.lost.auditEntries >= 1);
      assert.match(report.text, /lacks \d+ audit entr/);
      // the backup itself was not touched by any of this and still restores on its own
      assert.equal(existsSync(join(backup.path, "manifest.json")), true);

      // a restore of a current backup loses nothing
      const second = await createBackup(live.storage, { root: join(dir, "backups2"), kind: "manual", version: "0.0.0-test", now: () => new Date(T), blobs });
      const third = await backend.open();
      try {
        await restoreBackup(second.path, third.storage, { blobs: restoredBlobs });
        const whole = await reportRestoredStore({ manifestDirectory: join(dir, "manifest"), storage: third.storage, blobs: restoredBlobs });
        assert.equal(whole.complete, true, whole.text);
        assert.match(whole.text, /Nothing listed/);
      } finally { await third.close(); }
    } finally { await live.close(); await fresh.close(); gone(dir); }
  });
}

test("a manifest that was changed, cut short, or never finished is refused, and nothing is guessed from it", async () => {
  const world = await backends[0]!.open();
  const dir = tmp();
  try {
    const blobs = await FileBlobStore.open({ directory: join(dir, "blobs") });
    const artifacts = await ArtifactService.open(world.storage, blobs, { holder: "c1", ...fast });
    await artifacts.publish({ commandId: cid("pub"), actor: "rob", name: "report", files: [file("a.txt", "alpha")] });
    const source = snapshotSource(world.storage);
    try { await writeRecoveryManifest(source, join(dir, "m")); } finally { await source.close(); }
    const manifestPath = join(dir, "m", "manifest.json");
    const original = readFileSync(manifestPath, "utf8");
    readRecoveryManifest(join(dir, "m"));
    // the manifest's own text changed
    writeFileSync(manifestPath, original.replace(/"auditSeq": \d+/, '"auditSeq": 0'));
    assert.throws(() => readRecoveryManifest(join(dir, "m")), (e: unknown) => e instanceof RecoveryManifestBad && /checksum/.test(e.message));
    writeFileSync(manifestPath, original);
    // a sidecar file changed
    const records = join(dir, "m", "aggregates.jsonl");
    const text = readFileSync(records, "utf8");
    writeFileSync(records, text.replace('"revision":1', '"revision":0'));
    assert.throws(() => readRecoveryManifest(join(dir, "m")), (e: unknown) => e instanceof RecoveryManifestBad && /aggregates\.jsonl does not match/.test(e.message));
    unlinkSync(records);
    assert.throws(() => readRecoveryManifest(join(dir, "m")), (e: unknown) => e instanceof RecoveryManifestBad && /missing/.test(e.message));
    // no manifest.json: a folder that was never finished
    unlinkSync(manifestPath);
    assert.throws(() => readRecoveryManifest(join(dir, "m")), (e: unknown) => e instanceof RecoveryManifestBad && /cannot be read/.test(e.message));
  } finally { await world.close(); gone(dir); }
});

test("a source that fails while the manifest is written leaves no manifest and no partial folder, and the earlier manifest stays", async () => {
  const dir = tmp();
  try {
    const good: RecoverySource = { watermark: async () => ({ epoch: 1, auditSeq: 5, deliverySeq: 0 }), aggregates: async function* () { yield { kind: "task", id: "t1", revision: 2 }; } };
    await writeRecoveryManifest(good, join(dir, "m"));
    const broken: RecoverySource = { watermark: async () => ({ epoch: 1, auditSeq: 9, deliverySeq: 0 }), aggregates: async function* () { yield { kind: "task", id: "t1", revision: 3 }; throw new Error("the connection dropped"); } };
    await assert.rejects(writeRecoveryManifest(broken, join(dir, "m")), /connection dropped/);
    assert.equal(readRecoveryManifest(join(dir, "m")).manifest.watermark.auditSeq, 5, "the earlier manifest is whole");
    assert.deepEqual(readdirSync(dir), ["m"], "no partial folder");
  } finally { gone(dir); }
});

test("tombstones are not state a recovery must find", async () => {
  const dir = tmp();
  try {
    const source: RecoverySource = { watermark: async () => ({ epoch: 1, auditSeq: 1, deliverySeq: 0 }), aggregates: async function* () { yield { kind: "tombstone", id: "t-x", revision: 4 }; yield { kind: "task", id: "t1", revision: 1 }; } };
    const m = await writeRecoveryManifest(source, join(dir, "m"));
    assert.equal(m.aggregates.rows, 1);
  } finally { gone(dir); }
});

test("loss is measured from what was acknowledged against what the new primary holds", () => {
  const acked = [1, 2, 3, 4, 5].map((seq) => ({ seq, ackedAtMs: 1000 + seq * 100 }));
  assert.deepEqual(measureLoss(acked, new Set([1, 2, 3, 4, 5])), { acknowledged: 5, surviving: 5, lost: 0, lostSeqs: [], windowMs: 0 });
  const some = measureLoss(acked, new Set([1, 2, 3]));
  assert.deepEqual({ ...some }, { acknowledged: 5, surviving: 3, lost: 2, lostSeqs: [4, 5], windowMs: 200 });
  const all = measureLoss(acked, new Set());
  assert.equal(all.lost, 5);
  assert.equal(all.windowMs, 400);
  assert.deepEqual(measureLoss([], new Set()), { acknowledged: 0, surviving: 0, lost: 0, lostSeqs: [], windowMs: 0 });
});

test("the standby is an optional capability: absent means none, anything else must be complete", () => {
  assert.equal(parseStandbyConfig(undefined), undefined);
  assert.equal(parseStandbyConfig(null), undefined);
  const ok = { name: "nn_standby", mode: "synchronous", url: "postgres://u:p@h:5432/d", manifestDirectory: "/m", blobDirectory: "/b" };
  assert.deepEqual(parseStandbyConfig(ok), ok);
  for (const [bad, why] of [
    [{ ...ok, mode: "sometimes" }, /mode/], [{ ...ok, name: "a b" }, /name/], [{ ...ok, url: "http://x" }, /postgres/], [{ ...ok, extra: 1 }, /not a setting/], [{ ...ok, manifestDirectory: "" }, /manifestDirectory/], ["on", /object/],
  ] as const) assert.throws(() => parseStandbyConfig(bad), (e: unknown) => e instanceof StandbyConfigBad && why.test(e.message));
  assert.match(describeMode("synchronous"), /survives losing the primary/);
  assert.match(describeMode("asynchronous"), /can be lost/);
});

// ---- the order of the refusals, with the steps stood in for (nothing here needs a server) ---------------------------------------------------------------------------------------------
async function manifestFor(dir: string, records: { kind: string; id: string; revision: number }[], blobsBody?: string): Promise<void> {
  const source: RecoverySource = { watermark: async () => ({ epoch: 2, auditSeq: 10, deliverySeq: 3 }), aggregates: async function* () { for (const r of records) yield { ...r, ...(blobsBody === undefined ? {} : { body: blobsBody }) }; } };
  await writeRecoveryManifest(source, dir);
}
const standbyFacts = { inRecovery: true, writable: false, systemIdentifier: "7", positionLsn: "0/5000000", receivedLsn: "0/5000000", synchronousStandbyNames: "", synchronousCommit: "on" };
const stateOf = (over: Partial<{ epoch: number; auditSeq: number; deliverySeq: number }>, records: { kind: string; id: string; revision: number }[]) => (): never => ({
  watermark: async () => ({ epoch: 2, auditSeq: 10, deliverySeq: 3, ...over }), aggregates: async function* () { yield* records; },
}) as never;
const allBlobs = { verify: async () => "ok" as const };

test("promotion is refused, with the standby untouched, for each of: no manifest, a writable node, an old primary still answering, replay behind, a behind or missing record, a missing blob", async () => {
  const dir = tmp();
  try {
    const record = { kind: "task", id: "t1", revision: 2 };
    const artifact = JSON.stringify({ entries: [{ path: "a", digest: "a".repeat(64), size: 3 }] });
    await manifestFor(join(dir, "ok"), [record]);
    await manifestFor(join(dir, "withblob"), [{ kind: "artifact", id: "x", revision: 1 }], artifact);
    let promoted = 0;
    const steps = (over: Record<string, unknown> = {}) => ({ probe: async () => standbyFacts, state: stateOf({}, [record]), promote: async () => { promoted++; return { promoted: true as const, positionLsn: "0/6000000" }; }, ...over }) as Parameters<typeof promoteDatabaseWith>[1];
    const base = { standby: { url: "postgres://x/y", schema: "nimblenewt" }, blobs: allBlobs, replayWaitMs: 60 };
    const oldIs = (old: Record<string, unknown> | "down") => ({ probe: async (url: string) => { if (!url.includes("old")) return standbyFacts; if (old === "down") throw new Error("connect ECONNREFUSED"); return { ...standbyFacts, ...old }; } });
    const refused = async (options: Parameters<typeof promoteDatabase>[0], s: Parameters<typeof promoteDatabaseWith>[1], pattern: RegExp): Promise<PromotionRefused> => {
      const before = promoted;
      const e = await promoteDatabaseWith(options, s).then(() => undefined, (error: unknown) => error);
      assert.ok(e instanceof PromotionRefused, String(e));
      assert.match(e.message, pattern);
      assert.equal(e.changed, false);
      assert.equal(promoted, before, "promote was not called");
      return e;
    };
    const ok = { ...base, manifestDirectory: join(dir, "ok") };
    await refused({ ...base, manifestDirectory: join(dir, "none") }, steps(), /cannot be read/);
    await refused(ok, steps({ probe: async () => ({ ...standbyFacts, inRecovery: false, writable: true }) }), /already a writable database/);
    await refused({ ...ok, oldPrimaryUrl: "postgres://old/x" }, steps(oldIs({ inRecovery: false, writable: true })), /still answers as a writable database/);
    // read-only by default is not read-only: a session there can still write
    await refused({ ...ok, oldPrimaryUrl: "postgres://old/x" }, steps(oldIs({ inRecovery: false, writable: false })), /not in recovery .*two primaries/);
    await refused({ ...ok, oldPrimaryUrl: "postgres://old/x" }, steps(oldIs({ systemIdentifier: "9" })), /not the primary this standby copies/);
    await refused(ok, steps({ probe: async () => ({ ...standbyFacts, positionLsn: "0/4000000" }) }), /not replayed/);
    for (const wait of [Number.NaN, -1, 1.5, 700_000]) await refused({ ...ok, replayWaitMs: wait }, steps(), /replayWaitMs/);
    let calls = 0;
    await refused(ok, steps({ probe: async () => { calls++; if (calls > 1) throw new Error("gone"); return { ...standbyFacts, positionLsn: "0/4000000" }; } }), /stopped answering while it replayed/);
    await refused(ok, steps({ state: stateOf({}, [{ ...record, revision: 1 }]) }), /revision 1 here but the manifest has 2/);
    await refused(ok, steps({ state: stateOf({}, []) }), /t1 is in the manifest but not on this node/);
    await refused(ok, steps({ state: stateOf({ auditSeq: 7 }, [record]) }), /audit log stops at 7/);
    await refused(ok, steps({ state: stateOf({ deliverySeq: 2 }, [record]) }), /delivery counter is 2/);
    await refused(ok, steps({ state: stateOf({ epoch: 1 }, [record]) }), /epoch is 1/);
    await refused({ ...base, manifestDirectory: join(dir, "withblob"), blobs: { verify: async () => "missing" as const } }, steps({ state: stateOf({}, [{ kind: "artifact", id: "x", revision: 1 }]) }), /artifact file aaaaaaaaaaaa\.\.\. is not on this node/);
    // and the same inputs, whole, are promoted: the database only
    const result = await promoteDatabaseWith(ok, steps());
    assert.equal(promoted, 1);
    assert.equal(result.database, "promoted");
    assert.equal(result.controller, "not_promoted");
    assert.match(result.notes.join(" "), /old primary's address was not given/);
    // an old primary that does not answer is not proof it is gone: the result says so
    const down = await promoteDatabaseWith({ ...ok, oldPrimaryUrl: "postgres://old/x" }, steps(oldIs("down")));
    assert.match(down.notes.join(" "), /did not answer.*partition/);
    // the public entry point takes no steps: a caller cannot replace a check
    assert.equal("promoteDatabaseWith" in recoveryIndex, false);
    assert.equal(promoteDatabase.length, 1);
  } finally { gone(dir); }
});

test("a manifest whose checksum matches but whose fields are not what this code writes is refused: a missing counter never skips its check", async () => {
  const dir = tmp();
  try {
    await manifestFor(join(dir, "m"), [{ kind: "task", id: "t1", revision: 2 }]);
    const path = join(dir, "m", "manifest.json");
    const original = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
    const rewrite = (change: (m: Record<string, unknown>) => void): void => {
      const m = structuredClone(original); delete m["sha256"]; change(m);
      writeFileSync(path, JSON.stringify({ ...m, sha256: createHash("sha256").update(canonicalJson(m as never)).digest("hex") }));
    };
    rewrite(() => undefined);
    readRecoveryManifest(join(dir, "m")); // re-hashed but unchanged: still good
    for (const [change, why] of [
      [(m: Record<string, unknown>) => { delete m["watermark"]; }, /watermark/],
      [(m: Record<string, unknown>) => { m["watermark"] = { epoch: 2, auditSeq: "10", deliverySeq: 3 }; }, /watermark/],
      [(m: Record<string, unknown>) => { delete (m["watermark"] as Record<string, unknown>)["deliverySeq"]; }, /watermark/],
      [(m: Record<string, unknown>) => { (m["aggregates"] as Record<string, unknown>)["file"] = "../elsewhere.jsonl"; }, /entry for aggregates/],
      [(m: Record<string, unknown>) => { (m["blobs"] as Record<string, unknown>)["rows"] = 1; }, /blobs\.jsonl has 0 entries/],
    ] as const) {
      rewrite(change);
      assert.throws(() => readRecoveryManifest(join(dir, "m")), (e: unknown) => e instanceof RecoveryManifestBad && why.test(e.message));
    }
  } finally { gone(dir); }
});

test("no custom PostgreSQL replication protocol: nothing in the replication code opens a replication connection, speaks the wire protocol or ships WAL", () => {
  const sources = [join(import.meta.dirname, "..", "..", "src", "storage", "postgres", "replication.ts"), ...readdirSync(join(import.meta.dirname, "..", "..", "src", "recovery")).filter((f) => f.endsWith(".ts") && !f.endsWith(".test.ts")).map((f) => join(import.meta.dirname, "..", "..", "src", "recovery", f))];
  const text = sources.filter((s) => existsSync(s)).map((s) => readFileSync(s, "utf8")).join("\n").replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
  assert.ok(text.length > 5000, "the sources were read");
  for (const forbidden of [/START_REPLICATION/i, /replication\s*=\s*(?:true|database)/i, /CopyBoth/i, /from "node:net"/, /from "node:dgram"/, /pg_receivewal|pg_basebackup/i, /pg-logical|pg-copy-streams|pg-protocol/i]) assert.doesNotMatch(text, forbidden);
  // and the one thing that changes the database's role is PostgreSQL's own function
  assert.match(text, /pg_promote\(/);
});
