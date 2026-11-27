import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { ArtifactService, FileBlobStore } from "../artifacts/index.js";
import { backends, stopServer } from "../domain/testing/backends.js";
import type { ControllerStorage } from "../storage/index.js";
import { canonicalJson } from "../storage/index.js";
import { createHash } from "node:crypto";
import { recoveryWatermarkLines } from "../status/status.js";
import {
  RECOVERY_MANIFEST_FILE, RecoveryManifestBad, RecoveryWatermarkService, RecoveryWriteRefused, readRecoveryManifest, readRecoveryManifestHeader, writeFencedRecoveryManifest, type RecoveryWatermarkStatus,
} from "./index.js";
import { keepNewerDisplaced } from "./writer.js";

// Card K04, recovery watermarks: the manifest is written only by the controller that holds the epoch and never goes back; the service writes it on its schedule and stops for good once it finds
// it is no longer the primary; the owner reads the latest watermark and what it does not cover yet. On all four storage backends where a store is involved.

after(stopServer);
const T = "2026-11-27T10:00:00.000Z";
const fast = { clock: () => T, pause: async () => undefined };
const file = (path: string, text: string) => ({ path, content: Buffer.from(text) });
let n = 0;
const cid = (label: string) => `${label}-${n++}`;
const tmp = (): string => mkdtempSync(join(tmpdir(), "nn-k04w-"));
const gone = (d: string): void => rmSync(d, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
const manifestText = (dir: string): string => readFileSync(join(dir, RECOVERY_MANIFEST_FILE), "utf8");
const refused = (reason: string, pattern?: RegExp) => (e: unknown): boolean => e instanceof RecoveryWriteRefused && e.reason === reason && (pattern === undefined || pattern.test(e.message));

/** The same store with `currentEpoch` replaced: lets a test change the epoch at an exact point of the write. Every other method is the store's own. */
function withEpochHook(storage: ControllerStorage, hook: (call: number, real: () => Promise<number>) => Promise<number>): ControllerStorage {
  let calls = 0;
  return new Proxy(storage, {
    get(target, key) {
      if (key === "currentEpoch") return () => hook(++calls, () => target.currentEpoch());
      const v = Reflect.get(target, key, target) as unknown;
      return typeof v === "function" ? (v as (...a: unknown[]) => unknown).bind(target) : v;
    },
  });
}

/** A manifest.json with the given watermark and a valid self-checksum (its files are not needed by the writer's check). */
function plantManifest(dir: string, watermark: { epoch: number; auditSeq: number; deliverySeq: number }, extra: Record<string, unknown> = {}): string {
  mkdirSync(dir, { recursive: true });
  const body = { format: 1, product: "nimblenewt", createdAt: T, watermark, aggregates: { file: "aggregates.jsonl", rows: 0, bytes: 0, sha256: "0".repeat(64) }, blobs: { file: "blobs.jsonl", rows: 0, bytes: 0, sha256: "0".repeat(64) }, notes: [], ...extra };
  const text = `${JSON.stringify({ ...body, sha256: createHash("sha256").update(canonicalJson(body)).digest("hex") }, null, 2)}\n`;
  writeFileSync(join(dir, RECOVERY_MANIFEST_FILE), text);
  return text;
}

for (const backend of backends) {
  test(`${backend.name}: only the controller holding the epoch writes the manifest; after another takes the epoch the old one is refused and the folder is left as it was`, async () => {
    const world = await backend.open();
    const dir = tmp();
    const blobs = await FileBlobStore.open({ directory: join(dir, "blobs") });
    try {
      const artifacts = await ArtifactService.open(world.storage, blobs, { holder: "c1", ...fast });
      await artifacts.publish({ commandId: cid("pub"), actor: "rob", name: "report", files: [file("a.txt", "alpha")] });
      const epoch = await world.storage.currentEpoch();
      const m = join(dir, "m");
      const written = await writeFencedRecoveryManifest({ storage: world.storage, epoch, directory: m, now: () => new Date(T) });
      assert.equal(written.watermark.epoch, epoch);
      assert.equal(readRecoveryManifest(m).blobRefs().length, 1, "the fenced writer writes a whole manifest a promotion can read");
      const before = manifestText(m);
      // Windows has no POSIX permission bits (a file reads 0o666): the owner-only mode is checked off Windows only.
      if (process.platform !== "win32") for (const f of ["manifest.json", "aggregates.jsonl", "blobs.jsonl"]) assert.equal(statSync(join(m, f)).mode & 0o777, 0o600, `${f} is the owner's alone`);

      // a second controller takes the epoch: the first is now an old primary
      await world.storage.acquireEpoch({ holder: "c2", at: T, expectedEpoch: epoch });
      await assert.rejects(writeFencedRecoveryManifest({ storage: world.storage, epoch, directory: m }), refused("stale_epoch", /no longer the primary/));
      assert.equal(manifestText(m), before, "the manifest in the folder is untouched");
      assert.deepEqual(readdirSync(dir).sort(), ["blobs", "m"], "no staging folder is left");
      // and into an empty folder it writes nothing at all
      const empty = join(dir, "empty");
      await assert.rejects(writeFencedRecoveryManifest({ storage: world.storage, epoch, directory: empty }), refused("stale_epoch"));
      assert.equal(existsSync(join(empty, RECOVERY_MANIFEST_FILE)), false);
      // the new holder writes, and its manifest replaces the older one
      const newer = await writeFencedRecoveryManifest({ storage: world.storage, epoch: epoch + 1, directory: m });
      assert.equal(newer.watermark.epoch, epoch + 1);
      assert.notEqual(manifestText(m), before);
      await assert.rejects(writeFencedRecoveryManifest({ storage: world.storage, epoch: 0, directory: m }), RangeError);
    } finally { await world.close(); gone(dir); }
  });

  test(`${backend.name}: a manifest never goes back: one of a newer epoch, or the same epoch with higher counters, from another copy of the database is kept, also when its checksum is damaged`, async () => {
    const live = await backend.open(); const old = await backend.open();
    const dir = tmp();
    try {
      // The old primary keeps running on its own copy after a failover: in its copy its epoch is still current, so only the manifest's watermark can stop it.
      await live.storage.acquireEpoch({ holder: "c1", at: T });
      await live.storage.acquireEpoch({ holder: "standby-promoted", at: T });
      await old.storage.acquireEpoch({ holder: "old", at: T });
      const liveEpoch = await live.storage.currentEpoch(); const oldEpoch = await old.storage.currentEpoch();
      assert.ok(liveEpoch > oldEpoch, `${liveEpoch} > ${oldEpoch}`);
      const m = join(dir, "m");
      await writeFencedRecoveryManifest({ storage: live.storage, epoch: liveEpoch, directory: m });
      const kept = manifestText(m);
      await assert.rejects(writeFencedRecoveryManifest({ storage: old.storage, epoch: oldEpoch, directory: m }), refused("manifest_newer", /epoch \d+, newer than this controller's/));
      assert.equal(manifestText(m), kept);
      // a damaged manifest (its checksum no longer matches) that still names the newer epoch stops the old writer too
      writeFileSync(join(m, RECOVERY_MANIFEST_FILE), kept.replace(/"createdAt": "[^"]*"/, '"createdAt": "2026-01-01T00:00:00.000Z"'));
      assert.throws(() => readRecoveryManifest(m), RecoveryManifestBad);
      await assert.rejects(writeFencedRecoveryManifest({ storage: old.storage, epoch: oldEpoch, directory: m }), refused("manifest_newer"));
      // the same epoch with higher counters (another copy at the same epoch that got further) is kept as well
      const same = join(dir, "same");
      const w = { epoch: oldEpoch, auditSeq: 1_000_000, deliverySeq: 0 };
      const planted = plantManifest(same, w);
      await assert.rejects(writeFencedRecoveryManifest({ storage: old.storage, epoch: oldEpoch, directory: same }), refused("manifest_newer", /ahead of this store/));
      assert.equal(manifestText(same), planted);
      const sameDeliveries = join(dir, "same-d");
      plantManifest(sameDeliveries, { epoch: oldEpoch, auditSeq: 0, deliverySeq: 1_000_000 });
      await assert.rejects(writeFencedRecoveryManifest({ storage: old.storage, epoch: oldEpoch, directory: sameDeliveries }), refused("manifest_newer"));
      // an older manifest, even a damaged one, is replaced by the current holder
      const older = join(dir, "older");
      plantManifest(older, { epoch: oldEpoch - 1, auditSeq: 0, deliverySeq: 0 }, { notes: ["x"] });
      writeFileSync(join(older, RECOVERY_MANIFEST_FILE), manifestText(older).replace('"x"', '"changed"'));
      const replaced = await writeFencedRecoveryManifest({ storage: old.storage, epoch: oldEpoch, directory: older });
      assert.equal(readRecoveryManifestHeader(older)?.sha256, replaced.sha256);
    } finally { await live.close(); await old.close(); gone(dir); }
  });

  test(`${backend.name}: a manifest.json whose watermark cannot be read is never replaced (nothing can say it is older), and the writer says so`, async () => {
    const world = await backend.open();
    const dir = tmp();
    try {
      await world.storage.acquireEpoch({ holder: "c1", at: T });
      const epoch = await world.storage.currentEpoch();
      for (const [name, text] of [["garbage", "not json"], ["no-watermark", JSON.stringify({ format: 1, product: "nimblenewt" })], ["other-format", JSON.stringify({ format: 2, product: "nimblenewt", watermark: { epoch: 0, auditSeq: 0, deliverySeq: 0 } })], ["huge", `${" ".repeat(70 * 1024)}{}`]] as const) {
        const m = join(dir, name); mkdirSync(m); writeFileSync(join(m, RECOVERY_MANIFEST_FILE), text);
        await assert.rejects(writeFencedRecoveryManifest({ storage: world.storage, epoch, directory: m }), refused("manifest_unreadable", /move it aside/), name);
        assert.equal(manifestText(m), text, name);
        assert.ok(!readdirSync(dir).some((f) => f.includes(".partial-")), "no staging folder is left");
      }
    } finally { await world.close(); gone(dir); }
  });

  test(`${backend.name}: the epoch is checked again just before the files are put in place and once more after: taken in between, nothing is written; taken just after, the new manifest is taken away again`, async () => {
    const world = await backend.open();
    const dir = tmp();
    try {
      await world.storage.acquireEpoch({ holder: "c1", at: T });
      const epoch = await world.storage.currentEpoch();
      const m = join(dir, "m");
      await writeFencedRecoveryManifest({ storage: world.storage, epoch, directory: m });
      const first = manifestText(m);
      // taken while the manifest was being made (the second look): the earlier manifest stays
      const during = withEpochHook(world.storage, async (call, real) => { if (call === 2) await world.storage.acquireEpoch({ holder: "c2", at: T }); return real(); });
      await assert.rejects(writeFencedRecoveryManifest({ storage: during, epoch, directory: m }), refused("stale_epoch", /while the manifest was made/));
      assert.equal(manifestText(m), first);

      // taken just after the swap (the third look): the manifest this writer put there is withdrawn, so no older manifest is left for a promotion to pass
      const e2 = await world.storage.currentEpoch();
      const m2 = join(dir, "m2");
      const justAfter = withEpochHook(world.storage, async (call, real) => { if (call === 3) await world.storage.acquireEpoch({ holder: "c3", at: T }); return real(); });
      await assert.rejects(writeFencedRecoveryManifest({ storage: justAfter, epoch: e2, directory: m2 }), (e: unknown) => refused("stale_epoch", /taken away again/)(e) && (e as RecoveryWriteRefused).withdrawn === true);
      assert.equal(existsSync(join(m2, RECOVERY_MANIFEST_FILE)), false);

      // ... unless the file there is no longer its own (the new holder already wrote one): that one is left alone
      const e3 = await world.storage.currentEpoch();
      const m3 = join(dir, "m3");
      let planted = "";
      const overtaken = withEpochHook(world.storage, async (call, real) => {
        if (call === 3) { await world.storage.acquireEpoch({ holder: "c4", at: T }); planted = plantManifest(m3, { epoch: e3 + 1, auditSeq: 0, deliverySeq: 0 }); }
        return real();
      });
      await assert.rejects(writeFencedRecoveryManifest({ storage: overtaken, epoch: e3, directory: m3 }), (e: unknown) => refused("stale_epoch", /already been replaced and was left alone/)(e) && (e as RecoveryWriteRefused).withdrawn === false);
      assert.equal(manifestText(m3), planted);

      // a store that answers an epoch this controller does not hold, while its snapshot says otherwise: the snapshot's epoch is checked on its own
      const e4 = await world.storage.currentEpoch();
      await world.storage.acquireEpoch({ holder: "c5", at: T });
      const lying = withEpochHook(world.storage, async () => e4);
      await assert.rejects(writeFencedRecoveryManifest({ storage: lying, epoch: e4, directory: join(dir, "m4") }), refused("stale_epoch", /snapshot carries epoch/));
      assert.equal(existsSync(join(dir, "m4", RECOVERY_MANIFEST_FILE)), false);
      // a store whose epoch is below the writer's (it is not the store this controller took) is refused as well
      await assert.rejects(writeFencedRecoveryManifest({ storage: world.storage, epoch: e4 + 50, directory: join(dir, "m5") }), refused("stale_epoch", /not this controller's/));
    } finally { await world.close(); gone(dir); }
  });

  test(`${backend.name}: the last look at the folder comes after the store's last answer: a newer manifest put in place while that answer was awaited is kept, even when this controller's own copy still says it holds the epoch`, async () => {
    const world = await backend.open();
    const dir = tmp();
    try {
      await world.storage.acquireEpoch({ holder: "c1", at: T });
      const epoch = await world.storage.currentEpoch();
      const m = join(dir, "m");
      await writeFencedRecoveryManifest({ storage: world.storage, epoch, directory: m });
      let planted = "";
      // A newer primary on its own copy of the database writes while this one waits for its store's answer before the swap; this store never sees the newer epoch.
      const ownCopy = withEpochHook(world.storage, async (call, real) => { if (call === 2) planted = plantManifest(m, { epoch: epoch + 1, auditSeq: 0, deliverySeq: 0 }); return real(); });
      await assert.rejects(writeFencedRecoveryManifest({ storage: ownCopy, epoch, directory: m }), refused("manifest_newer", /newer than this controller's/));
      assert.equal(manifestText(m), planted, "the newer manifest is not replaced");
      assert.ok(!readdirSync(dir).some((f) => f.includes(".partial-")), "no staging folder is left");
    } finally { await world.close(); gone(dir); }
  });

  test(`${backend.name}: the service writes on its schedule, reports the latest watermark and what it does not cover yet, and once fenced never writes again`, async () => {
    const world = await backend.open();
    const dir = tmp();
    const blobs = await FileBlobStore.open({ directory: join(dir, "blobs") });
    try {
      const artifacts = await ArtifactService.open(world.storage, blobs, { holder: "c1", ...fast });
      const epoch = await world.storage.currentEpoch();
      let now = Date.parse(T);
      const m = join(dir, "m");
      const service = new RecoveryWatermarkService({ storage: world.storage, epoch, directory: m, everyMs: 60_000, now: () => new Date(now) });
      assert.deepEqual((await service.status()).manifest, { state: "absent" });
      assert.equal(await service.runDue(), "written");
      assert.equal(await service.runDue(), "not_due");
      let st = await service.status();
      assert.equal(st.manifest.state, "ok");
      assert.deepEqual(st.notCovered, { auditEntries: 0, deliveries: 0, earlierEpoch: false });
      assert.equal(st.last?.outcome, "written");

      await artifacts.publish({ commandId: cid("pub"), actor: "rob", name: "later", files: [file("c.txt", "charlie")] });
      st = await service.status();
      assert.ok((st.notCovered?.auditEntries ?? 0) >= 1, JSON.stringify(st));
      now += 59_999;
      assert.equal(await service.runDue(), "not_due");
      now += 1;
      assert.equal(await service.runDue(), "written");
      assert.equal((await service.status()).notCovered?.auditEntries, 0);
      const twoAtOnce = await Promise.all([service.writeNow(), service.writeNow(), service.runDue()]);
      assert.deepEqual(twoAtOnce, ["written", "written", "written"], "calls while one runs share it");

      // another controller takes the epoch: the next run is refused, the service is fenced and never asks again, even long after
      await world.storage.acquireEpoch({ holder: "c2", at: T });
      const kept = manifestText(m);
      now += 120_000;
      assert.equal(await service.runDue(), "fenced");
      st = await service.status();
      assert.equal(st.fenced, true);
      assert.equal(st.last?.refusal, "stale_epoch");
      assert.equal(st.notCovered?.earlierEpoch, true, "the manifest is of an earlier epoch than the store's now");
      let looked = 0;
      const counted = withEpochHook(world.storage, async (_c, real) => { looked++; return real(); });
      const fencedLater = new RecoveryWatermarkService({ storage: counted, epoch, directory: m, everyMs: 60_000, now: () => new Date(now) });
      assert.equal(await fencedLater.runDue(), "fenced");
      now += 86_400_000;
      assert.equal(await fencedLater.runDue(), "fenced");
      assert.equal(await fencedLater.writeNow(), "fenced");
      assert.equal(looked, 1, "a fenced service does not even look again");
      assert.equal(manifestText(m), kept);
      assert.equal(await service.writeNow(), "fenced");
    } finally { await world.close(); gone(dir); }
  });
}

test("the service is not fenced by an unreadable manifest: it says why, and writes once the owner has moved it aside; a failure is kept with a bounded reason and no path", async () => {
  const world = await backends[0]!.open();
  const dir = tmp();
  try {
    await world.storage.acquireEpoch({ holder: "c1", at: T });
    const epoch = await world.storage.currentEpoch();
    let now = Date.parse(T);
    const m = join(dir, "where-the-owner-keeps-it");
    mkdirSync(m); writeFileSync(join(m, RECOVERY_MANIFEST_FILE), "{");
    const service = new RecoveryWatermarkService({ storage: world.storage, epoch, directory: m, now: () => new Date(now) });
    assert.equal(await service.runDue(), "refused");
    let st = await service.status();
    assert.equal(st.fenced, false);
    assert.equal(st.last?.refusal, "manifest_unreadable");
    assert.equal(st.manifest.state, "unreadable");
    assert.ok(!JSON.stringify(st).includes("where-the-owner-keeps-it"), "no path in the status");
    rmSync(join(m, RECOVERY_MANIFEST_FILE));
    assert.equal(await service.runDue(), "not_due");
    now += 15 * 60_000;
    assert.equal(await service.runDue(), "written");
    st = await service.status();
    assert.equal(st.manifest.state, "ok");

    // a store that fails is a failure, not a fence; the reason is one bounded line
    const failing = withEpochHook(world.storage, async () => { throw new Error(`database unreachable ${"x".repeat(1000)}\n second line`); });
    const s2 = new RecoveryWatermarkService({ storage: failing, epoch, directory: join(dir, "m2"), now: () => new Date(now) });
    assert.equal(await s2.runDue(), "failed");
    const last = (await s2.status()).last!;
    assert.equal(last.outcome, "failed");
    assert.ok(last.reason!.length <= 300 && !last.reason!.includes("\n"), last.reason);
    assert.equal(s2.fenced, false);

    for (const everyMs of [59_999, 86_400_001, 1.5, Number.NaN]) assert.throws(() => new RecoveryWatermarkService({ storage: world.storage, epoch, directory: m, everyMs }), RangeError, String(everyMs));
    assert.throws(() => new RecoveryWatermarkService({ storage: world.storage, epoch: 0, directory: m }), RangeError);
    assert.throws(() => new RecoveryWatermarkService({ storage: world.storage, epoch, directory: "" }), RangeError);
  } finally { await world.close(); gone(dir); }
});

test("a manifest another writer put in place between the last look and the swap is put back when it is ahead or unreadable, and stays replaced when it is older", () => {
  const dir = tmp();
  try {
    const setUp = (name: string, displacedText: string | undefined): { d: string; x: string; ours: ReturnType<typeof readRecoveryManifestHeader> & object } => {
      const d = join(dir, name); const x = join(dir, `${name}-displaced`);
      plantManifest(d, { epoch: 3, auditSeq: 10, deliverySeq: 1 }, { notes: ["ours"] });
      writeFileSync(join(d, "aggregates.jsonl"), "ours\n");
      mkdirSync(x);
      if (displacedText !== undefined) { writeFileSync(join(x, RECOVERY_MANIFEST_FILE), displacedText); writeFileSync(join(x, "aggregates.jsonl"), "theirs\n"); }
      return { d, x, ours: readRecoveryManifestHeader(d)! };
    };
    const looked = plantManifest(join(dir, "looked"), { epoch: 3, auditSeq: 5, deliverySeq: 1 });
    const newer = plantManifest(join(dir, "newer"), { epoch: 4, auditSeq: 0, deliverySeq: 0 });
    const sameAhead = plantManifest(join(dir, "same-ahead"), { epoch: 3, auditSeq: 11, deliverySeq: 1 });
    const older = plantManifest(join(dir, "older"), { epoch: 2, auditSeq: 99, deliverySeq: 9 });

    for (const [name, text] of [["newer", newer], ["same-ahead", sameAhead]] as const) {
      const { d, x, ours } = setUp(name + "-case", text);
      assert.throws(() => keepNewerDisplaced(d, x, looked, 3, ours), (e: unknown) => refused("manifest_newer", /it was put back/)(e) && (e as RecoveryWriteRefused).withdrawn === true, name);
      assert.equal(manifestText(d), text, name);
      assert.equal(readFileSync(join(d, "aggregates.jsonl"), "utf8"), "theirs\n", "its files come back with it");
    }
    {
      const { d, x, ours } = setUp("garbage", "{ not json");
      assert.throws(() => keepNewerDisplaced(d, x, looked, 3, ours), refused("manifest_unreadable", /put back/));
      assert.equal(manifestText(d), "{ not json", "an unreadable manifest is never replaced");
    }
    {
      const huge = " ".repeat(64 * 1024 + 1);
      const { d, x, ours } = setUp("huge", huge);
      assert.throws(() => keepNewerDisplaced(d, x, looked, 3, ours), refused("manifest_unreadable", /put back/));
      assert.equal(manifestText(d), huge, "one too large to read is put back too");
    }
    for (const [name, text] of [["looked", looked], ["older", older], ["absent", undefined]] as const) {
      const { d, x, ours } = setUp(name + "-ok", text);
      const before = manifestText(d);
      keepNewerDisplaced(d, x, looked, 3, ours);
      assert.equal(manifestText(d), before, name);
    }
    {
      // the folder changed once more (a third writer): nothing is moved
      const { d, x, ours } = setUp("third", newer);
      const third = plantManifest(d, { epoch: 5, auditSeq: 0, deliverySeq: 0 });
      assert.throws(() => keepNewerDisplaced(d, x, looked, 3, ours), (e: unknown) => refused("manifest_newer", /left alone/)(e) && (e as RecoveryWriteRefused).withdrawn === false);
      assert.equal(manifestText(d), third);
    }
  } finally { gone(dir); }
});

test("the writer refuses a folder that is a symbolic link, manifest files that are not plain files, and a relative folder; a failure names no path", async () => {
  const world = await backends[0]!.open();
  const dir = tmp();
  try {
    await world.storage.acquireEpoch({ holder: "c1", at: T });
    const epoch = await world.storage.currentEpoch();
    const real = join(dir, "real"); mkdirSync(real);
    const link = join(dir, "link"); symlinkSync(real, link);
    await assert.rejects(writeFencedRecoveryManifest({ storage: world.storage, epoch, directory: link }), (e: unknown) => !(e instanceof RecoveryWriteRefused) && /symbolic link/.test((e as Error).message));
    assert.deepEqual(readdirSync(real), [], "nothing is written through the link");
    for (const f of ["manifest.json", "aggregates.jsonl", "blobs.jsonl"]) {
      const m = join(dir, `with-${f}`); mkdirSync(m);
      const target = join(dir, `target-${f}`); writeFileSync(target, "kept");
      symlinkSync(target, join(m, f));
      await assert.rejects(writeFencedRecoveryManifest({ storage: world.storage, epoch, directory: m }), refused("manifest_unreadable", /not a plain file/), f);
      assert.equal(readFileSync(target, "utf8"), "kept", f);
      assert.equal(existsSync(join(m, f)), true, f);
    }
    await assert.rejects(writeFencedRecoveryManifest({ storage: world.storage, epoch, directory: "relative/m" }), RangeError);
    assert.throws(() => new RecoveryWatermarkService({ storage: world.storage, epoch, directory: "relative/m" }), RangeError);
    // a file-system error names its path: only its code is kept for the owner's status
    const blocker = join(dir, "where-the-owner-keeps-it"); writeFileSync(blocker, "a file, not a folder");
    const service = new RecoveryWatermarkService({ storage: world.storage, epoch, directory: join(blocker, "m") });
    assert.equal(await service.runDue(), "failed");
    const reason = (await service.status()).last?.reason ?? "";
    assert.match(reason, /\(ENOTDIR\)/);
    assert.ok(!reason.includes("where-the-owner-keeps-it"), reason);
  } finally { await world.close(); gone(dir); }
});

test("the header reader checks manifest.json alone (checksum, watermark, time) and refuses an oversized file unread", () => {
  const dir = tmp();
  try {
    assert.equal(readRecoveryManifestHeader(join(dir, "none")), undefined);
    const good = join(dir, "good"); plantManifest(good, { epoch: 3, auditSeq: 7, deliverySeq: 2 });
    assert.deepEqual(readRecoveryManifestHeader(good)?.watermark, { epoch: 3, auditSeq: 7, deliverySeq: 2 });
    const changed = join(dir, "changed"); plantManifest(changed, { epoch: 3, auditSeq: 7, deliverySeq: 2 });
    writeFileSync(join(changed, RECOVERY_MANIFEST_FILE), manifestText(changed).replace('"auditSeq": 7', '"auditSeq": 9'));
    assert.throws(() => readRecoveryManifestHeader(changed), /checksum/);
    const noTime = join(dir, "no-time"); plantManifest(noTime, { epoch: 1, auditSeq: 0, deliverySeq: 0 }, { createdAt: "yesterday" });
    assert.throws(() => readRecoveryManifestHeader(noTime), /time it was written/);
    const big = join(dir, "big"); mkdirSync(big); writeFileSync(join(big, RECOVERY_MANIFEST_FILE), " ".repeat(64 * 1024 + 1));
    assert.throws(() => readRecoveryManifestHeader(big), /larger than any this version writes/);
  } finally { gone(dir); }
});

test("the owner's lines: schedule, the latest watermark, what it does not cover, a refused write, a fenced controller; values are bounded", () => {
  const ref = { kind: "installation", id: "installation" };
  const text = (st: RecoveryWatermarkStatus): string => recoveryWatermarkLines(st, ref).map((l) => l.text).join(" | ");
  const ok = { state: "ok" as const, createdAt: T, watermark: { epoch: 4, auditSeq: 120, deliverySeq: 9 }, records: 31, blobs: 1 };
  assert.match(text({ everyMs: 900_000, epoch: 4, fenced: false, manifest: { state: "absent" } }), /every 15 minutes .*epoch 4.*No recovery manifest has been written yet/);
  const covered = text({ everyMs: 60_000, epoch: 4, fenced: false, manifest: ok, notCovered: { auditEntries: 0, deliveries: 0, earlierEpoch: false }, last: { at: T, outcome: "written" } });
  assert.match(covered, /every 1 minute by/); assert.match(covered, /epoch 4, audit entry 120 and delivery 9; it lists 31 records and 1 artifact file\./); assert.match(covered, /covers everything/);
  assert.doesNotMatch(covered, /last write/);
  assert.match(text({ everyMs: 900_000, epoch: 4, fenced: false, manifest: ok, notCovered: { auditEntries: 1, deliveries: 3, earlierEpoch: false } }), /1 more audit entry and 3 more deliveries; a promotion checked against it cannot vouch/);
  const fenced = text({ everyMs: 900_000, epoch: 4, fenced: true, manifest: ok, notCovered: { auditEntries: 5, deliveries: 0, earlierEpoch: true }, last: { at: T, outcome: "refused", refusal: "stale_epoch", reason: "another controller took the epoch", withdrawn: true } });
  assert.match(fenced, /no longer the primary, so it writes no more recovery manifests/); assert.match(fenced, /earlier epoch/); assert.match(fenced, /was refused: another controller took the epoch \(the manifest it had put in place was taken away again\)/);
  // second review: fenced by a newer manifest in the folder, which a store restored from an older copy also meets: not said to be a takeover
  const byNewer = text({ everyMs: 900_000, epoch: 4, fenced: true, manifest: ok, last: { at: T, outcome: "refused", refusal: "manifest_newer", reason: "the manifest in the folder was written under epoch 7" } });
  assert.match(byNewer, /writes no more recovery manifests until it is restarted: the folder holds one newer than its store \(written by a controller that took over, or before this store was restored from an older copy\)/);
  assert.doesNotMatch(byNewer, /found it is no longer the primary/);
  const long = text({ everyMs: 900_000, epoch: 4, fenced: false, manifest: { state: "unreadable", reason: "y".repeat(5000) }, last: { at: T, outcome: "failed", reason: "z".repeat(5000) } });
  assert.match(long, /cannot be used/); assert.match(long, /failed: z/);
  assert.ok(long.length < 1200, String(long.length));
});
