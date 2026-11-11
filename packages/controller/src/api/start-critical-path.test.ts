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

// Card U11d ("U11f") through the running controller: the owner marks by the state API, a decision that holds up the marked task becomes Urgent and is told once with IDs only, the Needs-you
// view and the status view show it first, and the owner takes the mark off.

const ext4: FilesystemDetector = async () => ({ type: "ext4", network: false });
const supported: EnvironmentFacts = { platform: "linux", arch: "x64", osRelease: "6.8.0-generic", nodeVersion: "22.19.0" };
const MIN = 60_000;
const TITLE = "Rotate the payroll signing key";

test("in the running controller the owner marks a task, its waiting decision is raised to Urgent once with IDs only, ranked first in the Needs-you view, and put back when the mark is taken off (card U11d, U11f)", async () => {
  const d = mkdtempSync(join(tmpdir(), "nn-crit-"));
  let clock = Date.parse("2026-11-11T12:00:00.000Z");
  const sent: { text: string }[] = [];
  const channels = { chat: { send: async (m: { deliveryId: string; text: string }) => { sent.push(m); } } };
  const c = await startController({ storage: { kind: "sqlite", path: join(d, "c.sqlite") }, argv: [], env: {}, print: () => undefined, facts: supported, filesystem: ext4, features: [], harnesses: [PI],
    dispatch: { timer: new ManualTimer(), manual: true, intervalMs: 1000 }, notifications: { channels, clock: () => new Date(clock).toISOString() } });
  try {
    assert.ok(c.dispatch !== undefined, c.dispatchProblem);
    const boot = await c.services.principals.bootstrapOwner({ name: "rob" });
    const owner = (await c.services.principals.authenticate(boot.token))!;
    const call = (op: string, args: Record<string, unknown>, commandId?: string) => c.api.handle(boot.token, { v: 1, op, ...(commandId === undefined ? {} : { commandId }), args } as never) as Promise<{ ok: boolean; result?: any; error?: { code: string; message?: string } }>;
    const notifications = NotificationService.withEpoch(c.storage, c.epoch, { channels, clock: () => new Date(clock).toISOString() });
    const settings = (await call("notifications.settings", {})).result.item.revision as number;
    assert.ok((await call("notifications.configure", { channel: "external", channelName: "chat", expectedRevision: settings }, "s1")).ok);
    const project = (await call("project.create", { name: "Garden" }, "p1")).result.id as string;
    const blockers = BlockerService.withEpoch(c.storage, c.epoch, { clock: () => new Date(clock).toISOString() });
    const makeTask = async (id: string, title: string) => (await c.services.projects.createTask({ commandId: id, actor: owner.id, projectId: project, title })).id;
    // The project has work that can go on, so the stopped-work trigger (a separate one) stays out of this test.
    const spare = await c.services.projects.createTask({ commandId: "t9", actor: owner.id, projectId: project, title: "Prune the roses" });
    await c.services.projects.transitionTask({ commandId: "t9r", actor: owner.id, taskId: spare.id, expectedRevision: spare.revision, to: "ready" });
    const quiet = await makeTask("t0", "Water the plants"); const task = await makeTask("t1", TITLE);
    const block = async (id: string, taskId: string, summary: string) => (await blockers.openBlocker({ commandId: id, actor: owner.id, type: "manual_hold", subject: { kind: "task", id: taskId }, summary, resolver: "owner" })).id;
    const quietBlocker = await block("b0", quiet, "Water question");
    const blocker = await block("b1", task, TITLE);
    await notifications.emitFromController({ commandId: "n0", kind: "blocker", ref: { kind: "blocker", id: quietBlocker } });
    const item = (await notifications.emitFromController({ commandId: "n1", kind: "blocker", ref: { kind: "blocker", id: blocker } })).itemId;
    const level = async () => (await notifications.inbox(owner)).items.find((i) => i.id === item)!.level;
    const tick = async (ms = 61_000) => { clock += ms; const t = await c.dispatch!.dispatcher.tick(); assert.ok(t.loops.some((l) => l.name === "urgent.watch" && l.ok), JSON.stringify(t.loops.filter((l) => !l.ok))); };
    const order = async () => (await call("status.ask", { request: { kind: "needs_you" } })).result;
    // Not marked: not critical, however long it waits (the quiet project item is older, so it leads).
    await tick(); await tick(10 * MIN);
    assert.equal(await level(), "needs-you");
    assert.equal(sent.filter((m) => /critical path/.test(m.text)).length, 0);
    // Nothing but the owner can mark: an agent token is refused.
    const agent = await c.services.principals.enroll(owner, { commandId: "e1", kind: "agent", name: "ann", grants: [{ action: "*", project: "*" }] } as never);
    void agent;
    const annToken = (await c.services.principals.issueCredential(owner, "agent:ann")).token;
    const refused = await c.api.handle(annToken, { v: 1, op: "critical.mark", commandId: "x1", args: { kind: "task", taskId: task } } as never) as { ok: boolean; error?: { code: string } };
    assert.ok(!refused.ok && refused.error?.code === "forbidden");
    // The owner marks it (a command ID applies once).
    for (let i = 0; i < 2; i++) { const r = await call("critical.mark", { kind: "task", taskId: task }, "m1"); assert.ok(r.ok, JSON.stringify(r)); }
    assert.deepEqual((await call("critical.list", {})).result.item.marks.map((m: { kind: string; id: string }) => `${m.kind}:${m.id}`), [`task:${task}`]);
    const ranked = (await order()).item.lines.map((l: { text: string }) => l.text) as string[];
    assert.match(ranked[0]!, /^On the critical path you marked: .*Rotate the payroll signing key/, ranked.join("\n"));
    const view = (await call("status.ask", { request: { kind: "critical_path" } })).result.item.lines.map((l: { text: string }) => l.text).join("\n");
    assert.match(view, /is on the critical path you marked/);
    assert.match(view, /Holds up the critical path: /);
    await tick();
    assert.equal(await level(), "needs-you", "just seen holding the path up");
    await tick(6 * MIN);
    assert.equal(await level(), "urgent");
    await tick();
    const told = sent.filter((m) => /the critical path is blocked/.test(m.text));
    assert.equal(told.length, 1, JSON.stringify(sent));
    assert.ok(told[0]!.text.includes(project) && told[0]!.text.includes(blocker));
    assert.ok(!sent.map((m) => m.text).join("|").includes(TITLE), "no task content leaves");
    await tick(10 * MIN);
    assert.equal(sent.filter((m) => /the critical path is blocked/.test(m.text)).length, 1, "told once");
    // The owner takes the mark off: still Urgent for the first minutes (hysteresis), then back to Needs you, silently.
    assert.ok((await call("critical.mark", { kind: "task", taskId: task, marked: false }, "m2")).ok);
    await tick(); await tick(2 * MIN);
    assert.equal(await level(), "urgent");
    const before = sent.length;
    await tick(5 * MIN);
    assert.equal(await level(), "needs-you");
    assert.equal(sent.length, before, "silent");
    // Turned off by the setting: the owner's number is accepted and refused when out of range, through the API.
    const rev = (await call("notifications.settings", {})).result.item.revision as number;
    const bad = await call("notifications.configure", { criticalBlockedAfterMinutes: 0, expectedRevision: rev }, "s2");
    assert.ok(!bad.ok && bad.error?.code === "invalid_command");
    assert.ok((await call("notifications.configure", { criticalBlockedAfterMinutes: null, expectedRevision: rev }, "s3")).ok);
  } finally { await c.close(); rmSync(d, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }); }
});
