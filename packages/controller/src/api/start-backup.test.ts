import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { FileBlobStore } from "../artifacts/index.js";
import { restoreBackup } from "../backup/index.js";
import { ManualTimer } from "../dispatch/testing/timer.js";
import type { EnvironmentFacts, FilesystemDetector } from "../environment/index.js";
import { SqliteStorage } from "../storage/index.js";
import { startController } from "./index.js";

const ext4: FilesystemDetector = async () => ({ type: "ext4", network: false });
const supported: EnvironmentFacts = { platform: "linux", arch: "x64", osRelease: "6.8.0-generic", nodeVersion: "22.19.0" };

test("the owner takes a backup through the state API, the nightly run keeps them, and the backup restores into a new database with the work in it (card K01)", async () => {
  const d = mkdtempSync(join(tmpdir(), "nn-bk-"));
  let clock = Date.parse("2026-10-29T10:00:00.000Z");
  const timer = new ManualTimer();
  const c = await startController({ storage: { kind: "sqlite", path: join(d, "c.sqlite") }, argv: [], env: {}, print: () => undefined, facts: supported, filesystem: ext4, features: [], harnesses: [], dispatch: { timer, intervalMs: 1000 },
    artifacts: { directory: join(d, "artifacts") }, backup: { directory: join(d, "backups"), now: () => new Date(clock) } });
  try {
    assert.ok(c.dispatch !== undefined, c.dispatchProblem);
    const boot = await c.services.principals.bootstrapOwner({ name: "rob" });
    const rob = await c.services.principals.authenticate(boot.token);
    const call = async (token: string, op: string, args: Record<string, unknown>, commandId?: string) => (await c.api.handle(token, { v: 1, op, ...(commandId === undefined ? {} : { commandId }), args } as never)) as any;
    const project = (await call(boot.token, "project.create", { name: "Garden" }, "p1")).result.id as string;
    await c.services.principals.enroll(rob, { commandId: "e-zed", kind: "agent", name: "zed", grants: [{ action: "task.read", project }] });
    const zed = (await c.services.principals.issueCredential(rob, "agent:zed")).token;

    assert.equal((await call(zed, "backup.now", {}, "b0")).error.code, "forbidden");
    assert.equal((await call(zed, "backup.list", {})).error.code, "forbidden");
    assert.equal((await call(boot.token, "backup.list", {})).result.items.length, 0);
    const made = await call(boot.token, "backup.now", {}, "b1");
    assert.ok(made.ok, JSON.stringify(made));
    assert.equal(made.result.item.kind, "manual");
    assert.ok(made.result.item.rows > 0);
    assert.equal((await call(boot.token, "backup.list", {})).result.items.length, 1);

    // The nightly run does nothing the same day, and makes a scheduled backup a day later.
    assert.ok((await c.dispatch.dispatcher.tick()).loops.some((l) => l.name === "backups.nightly" && l.ok));
    assert.equal((await call(boot.token, "backup.list", {})).result.items.length, 1);
    clock += 25 * 3_600_000;
    await c.dispatch.dispatcher.tick();
    // The run is started by the tick and finishes on its own.
    for (let i = 0; i < 200 && (await call(boot.token, "backup.list", {})).result.items.length < 2; i++) await new Promise((r) => setTimeout(r, 25));
    const listed = (await call(boot.token, "backup.list", {})).result;
    assert.deepEqual(listed.items.map((i: { kind: string }) => i.kind), ["scheduled", "manual"]);
    assert.equal(listed.status.running, false);

    // The first backup restores into a new, empty database, and the project made before it is there.
    const backups = await c.services.backups!.list();
    assert.equal(backups[1]!.manifest.artifacts?.blobs, 0, "the installation has an artifact store, so its (empty) contents are part of the backup");
    const target = await SqliteStorage.open({ path: join(d, "restored.sqlite") });
    try {
      const done = await restoreBackup(backups[1]!.path, target, { blobs: await FileBlobStore.open({ directory: join(d, "restored-artifacts") }) });
      assert.ok(done.rows > 0);
      const projects = await target.listAggregates("project", { limit: 10 });
      assert.deepEqual(projects.map((p) => p.id), [project]);
    } finally { await target.close(); }
  } finally { await c.close(); rmSync(d, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }); }
});

test("without a backup folder the operations answer unavailable", async () => {
  const d = mkdtempSync(join(tmpdir(), "nn-bk-"));
  const c = await startController({ storage: { kind: "sqlite", path: join(d, "c.sqlite") }, argv: [], env: {}, print: () => undefined, facts: supported, filesystem: ext4, features: [], harnesses: [] });
  try {
    const boot = await c.services.principals.bootstrapOwner({ name: "rob" });
    const r = (await c.api.handle(boot.token, { v: 1, op: "backup.list", args: {} } as never)) as any;
    assert.equal(r.error.code, "unavailable");
  } finally { await c.close(); rmSync(d, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }); }
});
