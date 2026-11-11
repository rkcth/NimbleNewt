import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { BlockerService } from "../domain/blockers.js";
import type { EnvironmentFacts, FilesystemDetector } from "../environment/index.js";
import { ManualTimer } from "../dispatch/testing/timer.js";
import { PI } from "../dispatch/testing/world.js";
import { NotificationService } from "../notifications/index.js";
import { startController } from "./index.js";

const ext4: FilesystemDetector = async () => ({ type: "ext4", network: false });
const supported: EnvironmentFacts = { platform: "linux", arch: "x64", osRelease: "6.8.0-generic", nodeVersion: "22.19.0" };
const MIN = 60_000;
const TITLE = "Rotate the payroll signing key";

const open = async (d: string, clock: () => number, sent: { text: string }[]) => {
  const channels = { chat: { send: async (m: { deliveryId: string; text: string }) => { sent.push(m); } } };
  const c = await startController({ storage: { kind: "sqlite", path: join(d, "c.sqlite") }, argv: [], env: {}, print: () => undefined, facts: supported, filesystem: ext4, features: [], harnesses: [PI],
    dispatch: { timer: new ManualTimer(), manual: true, intervalMs: 1000 }, notifications: { channels, clock: () => new Date(clock()).toISOString() } });
  assert.ok(c.dispatch !== undefined, c.dispatchProblem);
  const boot = await c.services.principals.bootstrapOwner({ name: "rob" });
  const owner = (await c.services.principals.authenticate(boot.token))!;
  const call = (op: string, args: Record<string, unknown>, commandId?: string) => c.api.handle(boot.token, { v: 1, op, ...(commandId === undefined ? {} : { commandId }), args } as never) as Promise<{ ok: boolean; result?: any; error?: { code: string; message?: string } }>;
  const notifications = NotificationService.withEpoch(c.storage, c.epoch, { channels, clock: () => new Date(clock()).toISOString() });
  const rev = async () => (await call("notifications.settings", {})).result.item.revision as number;
  const set = async (args: Record<string, unknown>, id: string) => { const r = await call("notifications.configure", { ...args, expectedRevision: await rev() }, id); assert.ok(r.ok, JSON.stringify(r)); };
  return { c, boot, owner, call, notifications, set };
};

test("in the running controller a decision that holds up a project with nothing else to do becomes Urgent, is told once with IDs only, and goes back to Needs you when a task can go on (card U11d)", async () => {
  const d = mkdtempSync(join(tmpdir(), "nn-stop-"));
  let clock = Date.parse("2026-11-11T12:00:00.000Z");
  const sent: { text: string }[] = [];
  const { c, owner, call, notifications, set } = await open(d, () => clock, sent);
  try {
    await set({ channel: "external", channelName: "chat" }, "s1");
    const project = (await call("project.create", { name: "Garden" }, "p1")).result.id as string;
    const task = (await c.services.projects.createTask({ commandId: "t1", actor: owner.id, projectId: project, title: TITLE })).id;
    const blocker = (await BlockerService.withEpoch(c.storage, c.epoch, { clock: () => new Date(clock).toISOString() }).openBlocker({ commandId: "b1", actor: owner.id, type: "manual_hold", subject: { kind: "task", id: task }, summary: TITLE, resolver: owner.id })).id;
    const item = (await notifications.emitFromController({ commandId: "n1", kind: "blocker", ref: { kind: "blocker", id: blocker } })).itemId;
    const level = async () => (await notifications.inbox(owner)).items.find((i) => i.id === item)!.level;
    const tick = async (ms = 61_000) => { clock += ms; const t = await c.dispatch!.dispatcher.tick(); assert.ok(t.loops.some((l) => l.name === "urgent.watch" && l.ok), JSON.stringify(t.loops.filter((l) => !l.ok))); };
    await tick();
    assert.equal(await level(), "needs-you", "just seen idle");
    await tick(31 * MIN);
    assert.equal(await level(), "urgent");
    await tick();
    const told = sent.filter((m) => /work is stopped/.test(m.text));
    assert.equal(told.length, 1, JSON.stringify(sent));
    assert.ok(told[0]!.text.includes(project) && told[0]!.text.includes(blocker));
    assert.ok(!sent.map((m) => m.text).join("|").includes(TITLE), "no task content leaves");
    await tick(5 * MIN);
    assert.equal(sent.filter((m) => /work is stopped/.test(m.text)).length, 1, "told once");
    // A second task of the project can go on: the first decision is back to Needs you, still open, nothing sent.
    const other = await c.services.projects.createTask({ commandId: "t2", actor: owner.id, projectId: project, title: "Water the plants" });
    await c.services.projects.transitionTask({ commandId: "m1", actor: owner.id, taskId: other.id, expectedRevision: other.revision, to: "ready" });
    const before = sent.length;
    await tick();
    assert.equal(await level(), "needs-you");
    assert.equal(sent.length, before, "silent");
    // The owner turns it off by the settings the chat reaches; nothing is raised again.
    await set({ stoppedWorkAfterMinutes: null }, "s2");
    await tick(120 * MIN);
    assert.equal(await level(), "needs-you");
  } finally { await c.close(); rmSync(d, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }); }
});

test("in the running controller the plain 09:00 digest waits for no stand-up: with one scheduled it is not sent, once it has ended it is (card U11d)", async () => {
  const d = mkdtempSync(join(tmpdir(), "nn-dig-"));
  let clock = Date.parse("2026-11-11T07:00:00.000Z");
  const sent: { text: string }[] = [];
  const { c, owner, call, notifications, set } = await open(d, () => clock, sent);
  try {
    await set({ channel: "external", channelName: "chat", escalateAfterHours: null }, "s1");
    const project = (await call("project.create", { name: "Garden" }, "p1")).result.id as string;
    const agent = (await c.services.agents.create(owner, { commandId: "ag-a", friendlyName: "A" })).id;
    const made = await call("standup.configure", { projectId: project, title: "Morning", roster: [`agent:${agent}`], time: "09:00", windowFrom: "08:00", windowTo: "10:00", timeZone: "UTC", recurrence: { kind: "daily" } }, "su1");
    assert.ok(made.ok, JSON.stringify(made));
    const task = (await c.services.projects.createTask({ commandId: "t1", actor: owner.id, projectId: project, title: TITLE })).id;
    const blocker = (await BlockerService.withEpoch(c.storage, c.epoch, { clock: () => new Date(clock).toISOString() }).openBlocker({ commandId: "b1", actor: owner.id, type: "manual_hold", subject: { kind: "task", id: task }, summary: TITLE, resolver: owner.id })).id;
    await notifications.emitFromController({ commandId: "n1", kind: "blocker", ref: { kind: "blocker", id: blocker } });
    const digests = async () => (await notifications.inbox(owner)).digests.length;
    const tick = async (to: string) => { clock = Date.parse(to); await c.dispatch!.dispatcher.tick(); };
    await tick("2026-11-11T09:05:00.000Z");
    assert.equal(await digests(), 0, "a stand-up is scheduled: no plain digest");
    // The stand-up ends; the next 09:00 the digest comes.
    const got = await call("standup.get", { scheduleId: made.result.scheduleId });
    const ended = await call("standup.update", { scheduleId: made.result.scheduleId, expectedRevision: got.result.item.schedule.revision, state: "ended" }, "su2");
    assert.ok(ended.ok, JSON.stringify(ended));
    await tick("2026-11-12T09:05:00.000Z");
    assert.equal(await digests(), 1, "no stand-up: the digest is sent");
  } finally { await c.close(); rmSync(d, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }); }
});
