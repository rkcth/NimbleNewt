import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { FileBlobStore } from "../artifacts/index.js";
import { ManualTimer } from "../dispatch/testing/timer.js";
import type { EnvironmentFacts, FilesystemDetector } from "../environment/index.js";
import { promoteController, readControllerAuthority, writeFencedRecoveryManifest } from "../recovery/index.js";
import { SqliteStorage } from "../storage/index.js";
import { startController } from "./index.js";

// Card K05, second slice, through the composed controller on one SQLite file: the successor restores a backup made BEFORE the promotion. The restored store keeps the promotion record, the
// successor's holder and an epoch no lower than the live one, so the returning old controller is still refused, the restore can be made again, and a promotion made after the restore was
// prepared still refuses the swap.
const ext4: FilesystemDetector = async () => ({ type: "ext4", network: false });
const supported: EnvironmentFacts = { platform: "linux", arch: "x64", osRelease: "6.8.0-generic", nodeVersion: "22.19.0" };
const at = (minute: number) => () => new Date(`2026-11-27T12:${String(minute).padStart(2, "0")}:00.000Z`);

test("the successor restores a backup made before the promotion: the old controller stays refused, the restore can be made twice, and a later promotion still refuses the swap (K05 second slice)", async () => {
  const d = mkdtempSync(join(tmpdir(), "nn-k05b-"));
  const dbPath = join(d, "c.sqlite"), manifests = join(d, "recovery");
  const lines: string[] = [];
  const base = { storage: { kind: "sqlite", path: dbPath }, argv: [], env: {}, print: (l: string) => { lines.push(l); }, facts: supported, filesystem: ext4, features: [], harnesses: [], dispatch: { timer: new ManualTimer(), manual: true },
    recovery: { manifestDirectory: manifests, everyMs: 60_000, now: at(0) }, backup: { directory: join(d, "backups") } };
  type C = Awaited<ReturnType<typeof startController>>;
  const open: C[] = [];
  const start = async (holder?: string): Promise<C> => { const c = await startController({ ...base, ...(holder === undefined ? {} : { holder }) } as never); open.push(c); return c; };
  const onFile = async <R>(f: (s: SqliteStorage) => Promise<R>): Promise<R> => { const s = await SqliteStorage.open({ path: dbPath }); try { return await f(s); } finally { await s.close(); } };
  const promote = (successor: string, promotionId: string, minute: number) => onFile(async (s) => {
    await writeFencedRecoveryManifest({ storage: s, epoch: await s.currentEpoch(), directory: manifests, now: at(minute) });
    return promoteController({ storage: s, manifestDirectory: manifests, blobs: await FileBlobStore.open({ directory: join(d, `blobs-${successor}`) }), successor, promotionId, now: at(minute) });
  });
  try {
    const a = await start();
    const boot = await a.services.principals.bootstrapOwner({ name: "rob" });
    const call = async (c: C, op: string, args: Record<string, unknown>, commandId?: string) => (await c.api.handle(boot.token, { v: 1, op, ...(commandId === undefined ? {} : { commandId }), args } as never)) as any;
    const projects = async (c: C): Promise<string> => JSON.stringify((await call(c, "project.list", {})).result);
    const stage = async (c: C, name: string, id: string): Promise<{ warnings: string[] }> => {
      const preview = await call(c, "backup.restore.preview", { name });
      assert.ok(preview.ok, JSON.stringify(preview));
      assert.ok((await call(c, "backup.restore.apply", { name, confirm: preview.result.item.token }, id)).ok);
      return preview.result.item;
    };
    assert.equal((await call(a, "project.create", { name: "Garden" }, "p1")).ok, true);
    const name = (await call(a, "backup.now", {}, "b1")).result.item.name as string;
    assert.equal((await call(a, "project.create", { name: "Late" }, "p2")).ok, true);
    await a.close();

    // 1. the promotion names controller-b; b starts and restores the backup made before it
    await promote("controller-b", "k05b1", 5);
    const b = await start("controller-b");
    const preview = await stage(b, name, "r1");
    assert.ok(preview.warnings.some((w: string) => /last controller promotion \(k05b1, naming controller-b\)/.test(w)), preview.warnings.join("\n"));
    const epochB = await onFile((s) => s.currentEpoch());
    await b.close();
    lines.length = 0;
    const b2 = await start("controller-b");
    assert.ok(lines.some((l) => /The restore of .* was applied/.test(l)), lines.join("\n"));
    const restored = await projects(b2);
    assert.ok(restored.includes("Garden") && !restored.includes("Late"), restored);
    assert.equal((await call(b2, "project.create", { name: "AfterRestore" }, "p3")).ok, true, "the successor works on the restored store");
    const status = JSON.stringify(await call(b2, "status.ask", { request: { kind: "database_transfer" } }));
    assert.match(status, /controller-b/, status);
    await b2.close();
    const after1 = await onFile(async (s) => ({ epoch: await s.currentEpoch(), record: await readControllerAuthority(s) }));
    assert.equal(after1.epoch, epochB + 1, "the restored store went on from the live epoch, not the backup's");
    assert.ok(after1.record !== undefined && after1.record !== "unreadable" && after1.record.promotionId === "k05b1" && after1.record.successor === "controller-b");

    // the returning old controller, and another name, are refused on the restored store
    await assert.rejects(start(), /the controller promotion k05b1 named controller-b .*this controller starts as controller/);
    await assert.rejects(start("controller-x"), /may not use this store/);

    // 2. the same backup restored a second time: the same
    const b3 = await start("controller-b");
    await stage(b3, name, "r2");
    await b3.close();
    const b4 = await start("controller-b");
    assert.equal((await projects(b4)).includes("AfterRestore"), false, "the second restore was applied too");
    await b4.close();
    await assert.rejects(start(), /named controller-b/);

    // 3. a restore staged by b, then a second promotion (naming controller-c) before b restarts: the swap is refused, b is refused, c starts on the data it had
    const b5 = await start("controller-b");
    assert.equal((await call(b5, "project.create", { name: "BeforeP2" }, "p4")).ok, true);
    await stage(b5, name, "r3");
    await b5.close();
    await promote("controller-c", "k05b2", 9);
    lines.length = 0;
    await assert.rejects(start("controller-b"), /the controller promotion k05b2 named controller-c/);
    assert.ok(lines.some((l) => /was not applied: the database was taken by another controller or a controller promotion/.test(l)), lines.join("\n"));
    const c = await start("controller-c");
    assert.ok((await projects(c)).includes("BeforeP2"), "the restore was not swapped in");
    assert.equal((await call(c, "backup.restore.cancel", {}, "rc")).result.cancelled, true);
    await c.close();
    for (const old of [undefined, "controller-b"]) await assert.rejects(start(old), /named controller-c/, String(old));
  } finally {
    for (const c of open) await c.close().catch(() => undefined);
    rmSync(d, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
  }
});
