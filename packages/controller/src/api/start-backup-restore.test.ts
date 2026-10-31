import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { ManualTimer } from "../dispatch/testing/timer.js";
import type { EnvironmentFacts, FilesystemDetector } from "../environment/index.js";
import { SqliteStorage } from "../storage/index.js";
import { startController } from "./index.js";

const ext4: FilesystemDetector = async () => ({ type: "ext4", network: false });
const supported: EnvironmentFacts = { platform: "linux", arch: "x64", osRelease: "6.8.0-generic", nodeVersion: "22.19.0" };

test("the owner restores a backup from inside the running controller: preview, approve, barrier, restart swaps it in (card K01h)", async () => {
  const d = mkdtempSync(join(tmpdir(), "nn-bkr-"));
  const live = join(d, "pi"); mkdirSync(join(live, "att-1"), { recursive: true });
  writeFileSync(join(live, "att-1", "history.jsonl"), '{"id":1}\n');
  const open = () => startController({ storage: { kind: "sqlite", path: join(d, "c.sqlite") }, argv: [], env: {}, print: () => undefined, facts: supported, filesystem: ext4, features: [], harnesses: [], dispatch: { timer: new ManualTimer(), intervalMs: 1000 },
    backup: { directory: join(d, "backups"), piState: { list: async () => [{ id: "att-1", dir: join(live, "att-1") }] }, restore: { piFinal: (id) => join(live, id) } } });
  let c = await open();
  try {
    const boot = await c.services.principals.bootstrapOwner({ name: "rob" });
    const rob = await c.services.principals.authenticate(boot.token);
    const call = async (token: string, op: string, args: Record<string, unknown>, commandId?: string) => (await c.api.handle(token, { v: 1, op, ...(commandId === undefined ? {} : { commandId }), args } as never)) as any;
    await call(boot.token, "project.create", { name: "Garden" }, "p1");
    const made = await call(boot.token, "backup.now", {}, "b1");
    const name = made.result.item.name as string;
    await call(boot.token, "project.create", { name: "Late" }, "p2");
    writeFileSync(join(live, "att-1", "history.jsonl"), '{"id":1}\n{"id":2}\n');
    await c.services.principals.enroll(rob, { commandId: "e-zed", kind: "agent", name: "zed", grants: [] });
    const zed = (await c.services.principals.issueCredential(rob, "agent:zed")).token;
    assert.equal((await call(zed, "backup.restore.preview", { name })).error.code, "forbidden");
    assert.equal((await call(zed, "backup.restore.apply", { name, confirm: "x" }, "r0")).error.code, "forbidden");

    const preview = await call(boot.token, "backup.restore.preview", { name });
    assert.ok(preview.ok, JSON.stringify(preview));
    assert.equal(preview.result.item.piFiles, 1);
    assert.equal((await call(boot.token, "backup.restore.apply", { name, confirm: "wrong" }, "r1")).error.code, "invalid_command");
    const applied = await call(boot.token, "backup.restore.apply", { name, confirm: preview.result.item.token }, "r2");
    assert.ok(applied.ok, JSON.stringify(applied));
    assert.equal(applied.result.item.restartRequired, true);
    // While the restore waits for the restart, commands are refused and the owner can still look and cancel.
    const refused = await call(boot.token, "project.create", { name: "Blocked" }, "p3");
    assert.equal(refused.error.code, "unavailable"); assert.match(refused.error.message, /maintenance/);
    assert.equal((await call(boot.token, "backup.restore.status", {})).result.item.barrier.held, true);
    assert.equal((await call(boot.token, "backup.list", {})).ok, true);
    assert.equal((await call(boot.token, "backup.restore.cancel", {}, "r3")).result.cancelled, true);
    assert.equal((await call(boot.token, "project.create", { name: "After cancel" }, "p4")).ok, true);
    // Prepare again and restart: the previous data is replaced by the backup.
    const again = await call(boot.token, "backup.restore.preview", { name });
    assert.ok((await call(boot.token, "backup.restore.apply", { name, confirm: again.result.item.token }, "r4")).ok);
    await c.close();
    c = await open();
    assert.equal(readFileSync(join(live, "att-1", "history.jsonl"), "utf8"), '{"id":1}\n');
    const boot2 = await c.services.principals.authenticate(boot.token).catch(() => undefined);
    assert.ok(boot2 !== undefined, "the owner's credential came back with the restored data");
    const projects = (await c.api.handle(boot.token, { v: 1, op: "project.list", args: {} } as never)) as any;
    const names = JSON.stringify(projects.result ?? projects);
    assert.ok(names.includes("Garden")); assert.equal(names.includes("Late"), false); assert.equal(names.includes("After cancel"), false);
    assert.ok(existsSync(join(d, "c.sqlite")));
  } finally { await c.close().catch(() => undefined); rmSync(d, { recursive: true, force: true }); }
});
