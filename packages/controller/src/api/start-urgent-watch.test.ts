import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { EnvironmentFacts, FilesystemDetector } from "../environment/index.js";
import { ManualTimer } from "../dispatch/testing/timer.js";
import { PI } from "../dispatch/testing/world.js";
import { NotificationService } from "../notifications/index.js";
import { startController } from "./index.js";

const ext4: FilesystemDetector = async () => ({ type: "ext4", network: false });
const supported: EnvironmentFacts = { platform: "linux", arch: "x64", osRelease: "6.8.0-generic", nodeVersion: "22.19.0" };
const HOUR = 3_600_000;

test("the running controller raises an Urgent item when no good backup was made within the owner's limit, tells it through the channel, and closes it when a backup is made (card U11c)", async () => {
  const d = mkdtempSync(join(tmpdir(), "nn-urg-"));
  let clock = Date.parse("2026-10-31T08:00:00.000Z");
  const sent: { text: string }[] = [];
  const channels = { chat: { send: async (m: { deliveryId: string; text: string }) => { sent.push(m); } } };
  const c = await startController({ storage: { kind: "sqlite", path: join(d, "c.sqlite") }, argv: [], env: {}, print: () => undefined, facts: supported, filesystem: ext4, features: [], harnesses: [PI],
    dispatch: { timer: new ManualTimer(), manual: true, intervalMs: 1000 }, artifacts: { directory: join(d, "artifacts") },
    backup: { directory: join(d, "backups"), now: () => new Date(clock), everyMs: 100 * 365 * 24 * HOUR }, notifications: { channels, clock: () => new Date(clock).toISOString() } });
  try {
    assert.ok(c.dispatch !== undefined, c.dispatchProblem);
    const boot = await c.services.principals.bootstrapOwner({ name: "rob" });
    const call = (op: string, args: Record<string, unknown>, commandId?: string) => c.api.handle(boot.token, { v: 1, op, ...(commandId === undefined ? {} : { commandId }), args } as never) as Promise<{ ok: boolean; result?: any; error?: { code: string; message?: string } }>;
    const rev = async () => (await call("notifications.settings", {})).result.item.revision as number;
    const set = async (args: Record<string, unknown>, id: string) => { const r = await call("notifications.configure", { ...args, expectedRevision: await rev() }, id); assert.ok(r.ok, JSON.stringify(r)); };
    await set({ channel: "external", channelName: "chat", backupMaxAgeHours: 24 }, "s1");
    const owner = (await c.services.principals.authenticate(boot.token))!;
    const open = async () => (await NotificationService.withEpoch(c.storage, c.epoch, { channels, clock: () => new Date(clock).toISOString() }).inbox(owner)).items.filter((i) => i.state !== "answered" && i.state !== "settled" && i.ref.kind === "backup");
    const tick = async () => { clock += 61_000; const t = await c.dispatch!.dispatcher.tick(); assert.ok(t.loops.some((l) => l.name === "urgent.watch" && l.ok), JSON.stringify(t.loops.filter((l) => !l.ok))); };
    await call("backup.now", {}, "b1");
    clock += HOUR; await tick();
    assert.equal((await open()).length, 0, "a backup an hour old is fine");
    clock += 24 * HOUR; await tick();
    const items = await open();
    assert.equal(items.length, 1, JSON.stringify(sent));
    assert.equal(items[0]!.level, "urgent");
    await tick();
    assert.equal(sent.filter((m) => /no good backup/.test(m.text)).length, 1, JSON.stringify(sent));
    await call("backup.now", {}, "b2");
    await tick();
    assert.equal((await open()).length, 0, "a new backup closes the item");
    // Switched off by the owner: an old backup raises nothing.
    await set({ backupMaxAgeHours: null }, "s2");
    clock += 100 * HOUR; await tick();
    assert.equal((await open()).length, 0);
  } finally { await c.close(); rmSync(d, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }); }
});
