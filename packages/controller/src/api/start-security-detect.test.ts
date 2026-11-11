import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { LocalWorker } from "../dispatch/local-worker.js";
import type { WorkerHost } from "../dispatch/index.js";
import { ManualTimer } from "../dispatch/testing/timer.js";
import { PI } from "../dispatch/testing/world.js";
import type { EnvironmentFacts, FilesystemDetector } from "../environment/index.js";
import { NotificationService } from "../notifications/index.js";
import { startController } from "./index.js";
import type { DispatchStartOptions } from "./dispatch-compose.js";

/**
 * Card U11d through the running controller: the detectors the controller runs itself (a task credential used on another task) and the hook the local worker is given (`reportSecurity`) reach the owner as Urgent items,
 * sent at once on the channel, once per event, bounded by the owner's hourly allowance, switched off and on by the owner through `notifications.configure` (the chat command), and without any credential in what leaves.
 */
const ext4: FilesystemDetector = async () => ({ type: "ext4", network: false });
const supported: EnvironmentFacts = { platform: "linux", arch: "x64", osRelease: "6.8.0-generic", nodeVersion: "22.19.0" };
const ANN = "agt-abcdefghijklmnopqrst";
type BuildServices = Parameters<NonNullable<DispatchStartOptions["local"]>["build"]>[0];
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const until = async (ok: () => Promise<boolean>, what: string): Promise<void> => { for (let i = 0; i < 100; i++) { if (await ok()) return; await sleep(30); } assert.fail(`timed out: ${what}`); };

test("U11d: a task credential used on other tasks raises one Urgent item per pair through the running controller, told once on the channel, with no credential in the text; the owner switches the detectors off and on by chat", async () => {
  const d = mkdtempSync(join(tmpdir(), "nn-sdet-"));
  const sent: { text: string }[] = [];
  const channels = { chat: { send: async (m: { deliveryId: string; text: string }) => { sent.push(m); } } };
  let hook: BuildServices["reportSecurity"] | undefined;
  const c = await startController({
    storage: { kind: "sqlite", path: join(d, "c.sqlite") }, argv: [], env: {}, print: () => undefined, facts: supported, filesystem: ext4, features: [], harnesses: [PI],
    dispatch: { timer: new ManualTimer(), manual: true, local: { acceptUnenforcedLimits: true, window: () => undefined, close: async () => undefined, build: (s: BuildServices) => { hook = s.reportSecurity; return new LocalWorker({ hostId: "host:w1", resources: { cpus: 1, memoryMb: 1024 }, version: "u11d", capabilities: () => ({ os: "linux", arch: "x64", harnesses: [{ name: "pi", version: "1.3.0" }], isolation: ["bubblewrap"], tools: [], workspaces: [] }), guards: s.guards, sandbox: { open: async (r) => ({ revision: r.revision, close: async () => undefined }) }, runtimes: { open: async () => { throw new Error("unused"); } } }) as unknown as WorkerHost; } } },
    notifications: { channels },
  } as never);
  try {
    assert.ok(c.dispatch !== undefined, c.dispatchProblem);
    const s = c.services;
    const boot = await s.principals.bootstrapOwner({ name: "rob" });
    const rob = (await s.principals.authenticate(boot.token))!;
    const call = async (token: string, op: string, args: Record<string, unknown>, commandId?: string) => (await c.api.handle(token, { v: 1, op, ...(commandId === undefined ? {} : { commandId }), args } as never)) as any;
    const project = (await call(boot.token, "project.create", { name: "Garden" }, "p1")).result.id as string;
    const task = async (n: number) => (await call(boot.token, "task.create", { projectId: project, title: `t${n}` }, `t${n}`)).result.id as string;
    const [mine, b, cc, dd, ee] = [await task(1), await task(2), await task(3), await task(4), await task(5)];
    await s.principals.enroll(rob, { commandId: "e-ann", kind: "agent", name: ANN, grants: [{ action: "history.read", project }, { action: "task.read", project }, { action: "attempt.work", project }] });
    const cred = (await s.taskCredentials.issue(rob, { commandId: "tc1", taskId: mine, agentId: `agent:${ANN}` })).token;
    const rev = async () => (await call(boot.token, "notifications.settings", {})).result.item.revision as number;
    const set = async (args: Record<string, unknown>, id: string) => { const r = await call(boot.token, "notifications.configure", { ...args, expectedRevision: await rev() }, id); assert.ok(r.ok, JSON.stringify(r)); };
    await set({ channel: "external", channelName: "chat" }, "s1");
    const notifications = NotificationService.withEpoch(c.storage, c.epoch, { channels });
    const items = async () => (await notifications.inbox(rob)).items.filter((i) => i.ref.kind === "security" && i.state !== "settled" && i.state !== "answered");

    // Its own task: allowed and silent. Another task: refused as before, and told to the detectors; the same pair again is the same event.
    assert.ok((await call(cred, "activity.steps", { taskId: mine })).ok);
    for (let i = 0; i < 3; i++) { const r = await call(cred, "activity.steps", { taskId: b }); assert.equal(r.ok, false); assert.equal(r.error.code, "forbidden"); }
    assert.equal((await call(cred, "activity.replay.open", { taskId: cc })).ok, false);
    await until(async () => (await items()).length === 2, "two items");
    await sleep(100);
    const open = await items();
    assert.equal(open.length, 2, "three refusals of one pair are one event; a second pair is a second");
    assert.ok(open.every((i) => i.level === "urgent"));
    assert.ok(open.every((i) => /wrong task or host/.test(i.label) && /detect-credential/.test(i.label)), JSON.stringify(open.map((i) => i.label)));
    await until(async () => { await c.dispatch!.dispatcher.tick(); return sent.filter((m) => /wrong task or host/.test(m.text)).length >= 2; }, "sent on the channel");
    await c.dispatch.dispatcher.tick(); await c.dispatch.dispatcher.tick();
    assert.equal(sent.filter((m) => /wrong task or host/.test(m.text)).length, 2, "told once each");
    const everything = JSON.stringify([sent, open]);
    assert.ok(!everything.includes(cred), "no credential in what leaves or is shown");
    assert.ok(!everything.includes(b) && !everything.includes(cc), "the key (the task pair) is never sent outside");

    // Switched off by chat: another pair raises nothing; on again: it is reported.
    await set({ securityDetectors: false }, "s2");
    assert.equal((await call(cred, "activity.steps", { taskId: dd })).ok, false);
    await sleep(200);
    assert.equal((await items()).length, 2);
    await set({ securityDetectors: true }, "s3");
    assert.equal((await call(cred, "activity.steps", { taskId: dd })).ok, false);
    await until(async () => (await items()).length === 3, "reported again once on");
    // The allowance of the detector is the owner's hourly security allowance (chat-settable): beyond it one collected item, no more.
    await set({ securityReportsPerHour: 3 }, "s4");
    assert.equal((await call(cred, "activity.steps", { taskId: ee })).ok, false);
    await until(async () => (await items()).length === 4, "the fourth is the collected item");
    assert.ok((await items()).some((i) => /held/.test(i.label)), JSON.stringify((await items()).map((i) => i.label)));
    assert.equal((await call(cred, "notifications.settings", {})).ok, false, "the task credential still cannot read the settings");
  } finally { await c.close(); rmSync(d, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }); }
});

test("U11d: the hook given to the local worker host reports as the local worker: Urgent at once, once per key, a malformed project is dropped, and it never throws", async () => {
  const d = mkdtempSync(join(tmpdir(), "nn-sdet2-"));
  const sent: { text: string }[] = [];
  const channels = { chat: { send: async (m: { deliveryId: string; text: string }) => { sent.push(m); } } };
  let hook: BuildServices["reportSecurity"] | undefined;
  const c = await startController({
    storage: { kind: "sqlite", path: join(d, "c.sqlite") }, argv: [], env: {}, print: () => undefined, facts: supported, filesystem: ext4, features: [], harnesses: [PI],
    dispatch: { timer: new ManualTimer(), manual: true, local: { acceptUnenforcedLimits: true, window: () => undefined, close: async () => undefined, build: (s: BuildServices) => { hook = s.reportSecurity; return new LocalWorker({ hostId: "host:w1", resources: { cpus: 1, memoryMb: 1024 }, version: "u11d", capabilities: () => ({ os: "linux", arch: "x64", harnesses: [{ name: "pi", version: "1.3.0" }], isolation: ["bubblewrap"], tools: [], workspaces: [] }), guards: s.guards, sandbox: { open: async (r) => ({ revision: r.revision, close: async () => undefined }) }, runtimes: { open: async () => { throw new Error("unused"); } } }) as unknown as WorkerHost; } } },
    notifications: { channels },
  } as never);
  try {
    assert.ok(c.dispatch !== undefined, c.dispatchProblem);
    const boot = await c.services.principals.bootstrapOwner({ name: "rob" });
    const rob = (await c.services.principals.authenticate(boot.token))!;
    const call = async (op: string, args: Record<string, unknown>, commandId?: string) => (await c.api.handle(boot.token, { v: 1, op, ...(commandId === undefined ? {} : { commandId }), args } as never)) as any;
    const rev = async () => (await call("notifications.settings", {})).result.item.revision as number;
    assert.ok((await call("notifications.configure", { channel: "external", channelName: "chat", expectedRevision: await rev() }, "s1")).ok);
    const notifications = NotificationService.withEpoch(c.storage, c.epoch, { channels });
    const items = async () => (await notifications.inbox(rob)).items.filter((i) => i.ref.kind === "security" && i.state !== "settled" && i.state !== "answered");
    assert.ok(hook !== undefined, "the host builder was handed the hook");
    assert.doesNotThrow(() => { hook!({ kind: "protected-path-touched", key: "ws:landing:aaa", projectId: "not-a-project" }); hook!({ kind: "protected-path-touched", key: "ws:landing:aaa" }); hook!({ kind: "nonsense", key: "x" }); hook!({ kind: "sandbox-escape-attempt", key: "" }); hook!(null as never); });
    await until(async () => (await items()).length === 1, "one item");
    await sleep(100);
    assert.equal((await items()).length, 1, "the same key is one event; a bad kind and an empty key raise nothing");
    const [item] = await items();
    assert.equal(item!.level, "urgent");
    assert.match(item!.label, /protected path/);
    assert.match(item!.label, /local-worker/);
    await until(async () => { await c.dispatch!.dispatcher.tick(); return sent.some((m) => /protected path/.test(m.text)); }, "sent at once");
    await c.dispatch.dispatcher.tick();
    assert.equal(sent.filter((m) => /protected path/.test(m.text)).length, 1, "told once");
  } finally { await c.close(); rmSync(d, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }); }
});
