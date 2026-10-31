import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { EnvironmentFacts, FilesystemDetector } from "../environment/index.js";
import { ManualTimer } from "../dispatch/testing/timer.js";
import { PI } from "../dispatch/testing/world.js";
import { NOTIFICATION_LIMITS, NotificationService } from "../notifications/index.js";
import { startController } from "./index.js";

const ext4: FilesystemDetector = async () => ({ type: "ext4", network: false });
const supported: EnvironmentFacts = { platform: "linux", arch: "x64", osRelease: "6.8.0-generic", nodeVersion: "22.19.0" };
const HOUR = 3_600_000;

test("the running controller escalates an unattended Needs-you item to Urgent once, tells it through the external channel, bounds the sweep, survives a restart and stops when switched off (card U11b)", async () => {
  const d = mkdtempSync(join(tmpdir(), "nn-ntfesc-"));
  const file = join(d, "c.sqlite");
  let clock = Date.parse("2026-10-30T08:00:00.000Z");
  const sent: { deliveryId: string; text: string }[] = [];
  const channels = { chat: { send: async (m: { deliveryId: string; text: string }) => { sent.push(m); } } };
  const open = () => startController({ storage: { kind: "sqlite", path: file }, argv: [], env: {}, print: () => undefined, facts: supported, filesystem: ext4, features: [], harnesses: [PI], dispatch: { timer: new ManualTimer(), manual: true, intervalMs: 1000 }, notifications: { channels, clock: () => new Date(clock).toISOString() } });
  let c = await open();
  const ntf = () => NotificationService.withEpoch(c.storage, c.epoch, { channels, clock: () => new Date(clock).toISOString() });
  try {
    assert.ok(c.dispatch !== undefined, c.dispatchProblem);
    const boot = await c.services.principals.bootstrapOwner({ name: "rob" });
    const call = (op: string, args: Record<string, unknown>, commandId?: string) => c.api.handle(boot.token, { v: 1, op, ...(commandId === undefined ? {} : { commandId }), args } as never) as Promise<{ ok: boolean; result?: any; error?: { code: string } }>;
    const rev = async () => (await call("notifications.settings", {})).result.item.revision as number;
    const set = async (args: Record<string, unknown>, id: string) => { const r = await call("notifications.configure", { ...args, expectedRevision: await rev() }, id); assert.ok(r.ok, JSON.stringify(r)); };
    await set({ channel: "external", channelName: "chat", escalateAfterHours: 24, escalationsPerHour: 1000, levelByKind: { maintenance: "needs-you" } }, "s1");
    const emit = async (n: number) => { for (let i = 0; i < n; i++) await ntf().emitFromController({ commandId: `e-${i}`, kind: "maintenance", level: "needs-you", ref: { kind: "thing", id: `t${i}` }, detail: `thing ${i} needs you` }); };
    await emit(1);
    // Items are new when the sweep first runs: waits are counted from then (first deploy does not flood).
    await c.dispatch!.dispatcher.tick();
    const items = async () => (await ntf().inbox((await c.services.principals.authenticate(boot.token))!)).items;
    const tick = async () => { clock += 61_000; const t = await c.dispatch!.dispatcher.tick(); assert.ok(t.loops.some((l) => l.name === "notifications.run" && l.ok), JSON.stringify(t.loops.filter((l) => !l.ok))); };
    clock += 23 * HOUR; await tick();
    assert.equal((await items())[0]!.urgent, false, "23 hours: not yet");
    clock += 2 * HOUR; await tick();
    assert.equal((await items())[0]!.urgent, true, "25 hours: raised by the dispatcher's tick");
    const urgent = sent.filter((m) => m.text.startsWith("URGENT"));
    assert.equal(urgent.length, 1, JSON.stringify(sent));
    await tick(); clock += HOUR; await tick();
    assert.equal(sent.filter((m) => m.text.startsWith("URGENT")).length, 1, "not told again by a later tick");
    // A restart does not tell it again.
    await c.close(); c = await open();
    clock += 61_000; await c.dispatch!.dispatcher.tick();
    assert.equal(sent.filter((m) => m.text.startsWith("URGENT")).length, 1, "not told again after a restart");
    // The sweep is bounded: more waiting items than one tick raises are raised over several ticks, oldest first.
    const more = NOTIFICATION_LIMITS.escalationsPerRun + 5;
    for (let i = 0; i < more; i++) { clock += 1000; await ntf().emitFromController({ commandId: `m-${i}`, kind: "maintenance", level: "needs-you", ref: { kind: "thing", id: `m${i}` }, detail: `more ${i}` }); }
    clock += 25 * HOUR;
    const owner0 = (await c.services.principals.authenticate(boot.token))!;
    const before = (await ntf().inbox(owner0)).items.filter((i) => i.urgent).length;
    clock += 61_000; await c.dispatch!.dispatcher.tick();
    const owner = (await c.services.principals.authenticate(boot.token))!;
    const raised = async () => (await ntf().inbox(owner)).items.filter((i) => i.urgent).length;
    assert.equal(await raised(), before + NOTIFICATION_LIMITS.escalationsPerRun, "one tick raises at most the bound");
    clock += 61_000; await c.dispatch!.dispatcher.tick();
    const total = await raised();
    assert.ok(total >= before + more, "the next tick raises the rest");
    for (let i = 0; i < 8; i++) { clock += 1000; await c.dispatch!.dispatcher.tick(); } // at most five sends a tick: the messages drain over a few ticks
    const told = sent.filter((m) => m.text.startsWith("URGENT")).length;
    assert.equal(told, total, "every raised item was told once through the channel");
    // Switched off by the owner: nothing more is raised.
    const rev2 = (await call("notifications.settings", {})).result.item.revision;
    assert.ok((await call("notifications.configure", { escalateAfterHours: null, expectedRevision: rev2 }, "off")).ok);
    await ntf().emitFromController({ commandId: "late", kind: "maintenance", level: "needs-you", ref: { kind: "thing", id: "late" }, detail: "late one" });
    clock += 100 * HOUR; await c.dispatch!.dispatcher.tick();
    assert.equal(sent.filter((m) => m.text.startsWith("URGENT")).length, told, "escalation is off");
  } finally { await c.close(); rmSync(d, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }); }
});

test("the first deploy on a backlog tells the owner of at most ten items an hour, the rest in one message, and the sweep is the last loop of the tick (card U11b review)", async () => {
  const d = mkdtempSync(join(tmpdir(), "nn-ntfflood-"));
  let clock = Date.parse("2026-10-30T08:00:00.000Z");
  const sent: { text: string }[] = [];
  const channels = { chat: { send: async (m: { deliveryId: string; text: string }) => { sent.push(m); } } };
  const c = await startController({ storage: { kind: "sqlite", path: join(d, "c.sqlite") }, argv: [], env: {}, print: () => undefined, facts: supported, filesystem: ext4, features: [], harnesses: [PI], dispatch: { timer: new ManualTimer(), manual: true, intervalMs: 1000 }, notifications: { channels, clock: () => new Date(clock).toISOString() } });
  try {
    assert.ok(c.dispatch !== undefined, c.dispatchProblem);
    const boot = await c.services.principals.bootstrapOwner({ name: "rob" });
    const call = (op: string, args: Record<string, unknown>, commandId?: string) => c.api.handle(boot.token, { v: 1, op, ...(commandId === undefined ? {} : { commandId }), args } as never) as Promise<{ ok: boolean; result?: any }>;
    const rev = async () => (await call("notifications.settings", {})).result.item.revision as number;
    assert.ok((await call("notifications.configure", { channel: "external", channelName: "chat", levelByKind: { maintenance: "needs-you" }, expectedRevision: await rev() }, "s1")).ok);
    assert.ok(!(await call("notifications.configure", { channel: "external", channelName: "nobody", expectedRevision: await rev() }, "s2")).ok, "a channel with no adapter is refused");
    const ntf = NotificationService.withEpoch(c.storage, c.epoch, { channels, clock: () => new Date(clock).toISOString() });
    for (let i = 0; i < 30; i++) await ntf.emitFromController({ commandId: `b-${i}`, kind: "maintenance", ref: { kind: "thing", id: `b${i}` }, detail: `old ${i}` });
    clock += 5 * 24 * HOUR;
    const run = async () => { clock += 61_000; const t = await c.dispatch!.dispatcher.tick(); assert.equal(t.loops[t.loops.length - 1]!.name, "notifications.run", "the notification sweep is the last loop"); assert.ok(t.loops.every((l) => l.ok), JSON.stringify(t.loops)); };
    await run();
    assert.equal(sent.filter((m) => m.text.startsWith("URGENT")).length, 0, "nothing for waits that began before the sweep ran");
    clock += 25 * HOUR;
    for (let i = 0; i < 6; i++) await run();
    const told = sent.filter((m) => m.text.startsWith("URGENT"));
    assert.ok(told.length <= 10, `${told.length} urgent messages in one hour`);
    assert.equal(told.filter((m) => /more items? escalated/.test(m.text)).length, 1);
  } finally { await c.close(); rmSync(d, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }); }
});
