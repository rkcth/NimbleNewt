import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { EnvironmentFacts, FilesystemDetector } from "../environment/index.js";
import { ManualTimer } from "../dispatch/testing/timer.js";
import { PI } from "../dispatch/testing/world.js";
import { HostService } from "../hosts/index.js";
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

test("a host that stops reporting is found through the real host service in the running controller, raised as Urgent, told through the channel, and closed when it reports again (card U11c review)", async () => {
  const d = mkdtempSync(join(tmpdir(), "nn-urgh-"));
  let clock = Date.parse("2026-10-31T08:00:00.000Z");
  const sent: { text: string }[] = [];
  const channels = { chat: { send: async (m: { deliveryId: string; text: string }) => { sent.push(m); } } };
  const c = await startController({ storage: { kind: "sqlite", path: join(d, "c.sqlite") }, argv: [], env: {}, print: () => undefined, facts: supported, filesystem: ext4, features: [], harnesses: [PI],
    dispatch: { timer: new ManualTimer(), manual: true, intervalMs: 1000 }, notifications: { channels, clock: () => new Date(clock).toISOString() } });
  try {
    assert.ok(c.dispatch !== undefined, c.dispatchProblem);
    const boot = await c.services.principals.bootstrapOwner({ name: "rob" });
    const rob = (await c.services.principals.authenticate(boot.token))!;
    const call = (op: string, args: Record<string, unknown>, commandId?: string) => c.api.handle(boot.token, { v: 1, op, ...(commandId === undefined ? {} : { commandId }), args } as never) as Promise<{ ok: boolean; result?: any }>;
    const rev = async () => (await call("notifications.settings", {})).result.item.revision as number;
    assert.ok((await call("notifications.configure", { channel: "external", channelName: "chat", hostDownAfterMinutes: 10, expectedRevision: await rev() }, "s1")).ok);
    await c.services.principals.enroll(rob, { commandId: "e-host", kind: "host", name: "w1", grants: [] });
    const hostP = (await c.services.principals.authenticate((await c.services.principals.issueCredential(rob, "host:w1")).token))!;
    const hosts = HostService.withEpoch(c.storage, c.epoch, c.services.assignments, { clock: () => new Date(clock).toISOString() });
    await hosts.announce(hostP, { commandId: "an", capabilities: { os: "linux", arch: "x64", harnesses: [{ name: "pi", version: "1.3.0" }], isolation: ["bubblewrap"], tools: [], workspaces: [] } });
    await hosts.heartbeat(hostP, { commandId: "hb1", sequence: 1 });
    const open = async () => (await NotificationService.withEpoch(c.storage, c.epoch, { channels, clock: () => new Date(clock).toISOString() }).inbox(rob)).items.filter((i) => i.state !== "answered" && i.state !== "settled" && i.ref.kind === "host-record");
    const tick = async () => { clock += 61_000; await c.dispatch!.dispatcher.tick(); };
    await tick();
    assert.equal((await open()).length, 0, "a host that just reported is fine");
    clock += 11 * 60_000; await tick(); await tick();
    assert.equal((await open()).length, 1);
    assert.equal(sent.filter((m) => /silent for 1\d minutes/.test(m.text)).length, 1, JSON.stringify(sent));
    await hosts.heartbeat(hostP, { commandId: "hb2", sequence: 2 });
    await tick();
    assert.equal((await open()).length, 0, "reporting again closes it");
  } finally { await c.close(); rmSync(d, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }); }
});

test("a service reports a security event through the state API; the owner is told at once, an agent and the owner's own call are refused, and the hourly limit is set by the same settings call the chat uses (card U11c)", async () => {
  const d = mkdtempSync(join(tmpdir(), "nn-urgs-"));
  const sent: { text: string }[] = [];
  const channels = { chat: { send: async (m: { deliveryId: string; text: string }) => { sent.push(m); } } };
  const c = await startController({ storage: { kind: "sqlite", path: join(d, "c.sqlite") }, argv: [], env: {}, print: () => undefined, facts: supported, filesystem: ext4, features: [], harnesses: [PI],
    dispatch: { timer: new ManualTimer(), manual: true, intervalMs: 1000 }, notifications: { channels } });
  try {
    assert.ok(c.dispatch !== undefined, c.dispatchProblem);
    const s = c.services;
    const boot = await s.principals.bootstrapOwner({ name: "rob" });
    const rob = (await s.principals.authenticate(boot.token))!;
    await s.principals.enroll(rob, { commandId: "e-svc", kind: "service", name: "scanner", grants: [] });
    await s.principals.enroll(rob, { commandId: "e-agt", kind: "agent", name: "agt-abcdefghijklmnopqrst", grants: [] });
    const svcToken = (await s.principals.issueCredential(rob, "service:scanner")).token;
    const agentToken = (await s.principals.issueCredential(rob, "agent:agt-abcdefghijklmnopqrst")).token;
    const call = (token: string, op: string, args: Record<string, unknown>, commandId?: string) => c.api.handle(token, { v: 1, op, ...(commandId === undefined ? {} : { commandId }), args } as never) as Promise<any>;
    const rev = async () => (await call(boot.token, "notifications.settings", {})).result.item.revision as number;
    const set = async (args: Record<string, unknown>, id: string) => { const r = await call(boot.token, "notifications.configure", { ...args, expectedRevision: await rev() }, id); assert.ok(r.ok, JSON.stringify(r)); };
    await set({ channel: "external", channelName: "chat", securityReportsPerHour: 1 }, "s1");
    const ok = await call(svcToken, "security.report", { kind: "integrity-check-failed", key: "blob-7" }, "r1");
    assert.ok(ok.ok, JSON.stringify(ok));
    assert.equal(ok.result.held, false);
    const held = await call(svcToken, "security.report", { kind: "integrity-check-failed", key: "blob-8" }, "r2");
    assert.ok(held.ok, JSON.stringify(held));
    assert.equal(held.result.held, true, "beyond the limit the owner set");
    for (const [token, who] of [[agentToken, "agent"], [boot.token, "owner"]] as const) {
      const bad = await call(token, "security.report", { kind: "integrity-check-failed", key: "x" }, `bad-${who}`);
      assert.equal(bad.ok, false, who);
    }
    assert.equal((await call(svcToken, "security.report", { kind: "weird", key: "x" }, "r3")).ok, false);
    await c.dispatch!.dispatcher.tick(); await c.dispatch!.dispatcher.tick();
    assert.equal(sent.filter((m) => /integrity check failed/i.test(m.text)).length, 1, JSON.stringify(sent));
  } finally { await c.close(); rmSync(d, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }); }
});
