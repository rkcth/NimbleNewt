import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { EventService } from "../events/index.js";
import type { EnvironmentFacts, FilesystemDetector } from "../environment/index.js";
import { ManualTimer } from "../dispatch/testing/timer.js";
import { startController } from "./index.js";

const ext4: FilesystemDetector = async () => ({ type: "ext4", network: false });
const supported: EnvironmentFacts = { platform: "linux", arch: "x64", osRelease: "6.8.0-generic", nodeVersion: "22.19.0" };

test("an idle event subscription with events waiting is expired by the running controller and the owner gets exactly one notice; the owner sets the idle time and cancels a subscription through the state API (card H06c)", async () => {
  const d = mkdtempSync(join(tmpdir(), "nn-events-"));
  let now = Date.parse("2026-10-27T10:00:00.000Z");
  const clock = (): string => new Date(now).toISOString();
  const timer = new ManualTimer();
  const c = await startController({ storage: { kind: "sqlite", path: join(d, "c.sqlite") }, argv: [], env: {}, print: () => undefined, facts: supported, filesystem: ext4, features: [], dispatch: { timer, manual: true, clock } });
  try {
    assert.ok(c.dispatch !== undefined, c.dispatchProblem);
    const boot = await c.services.principals.bootstrapOwner({ name: "rob" });
    const owner = await c.services.principals.authenticate(boot.token);
    const project = (await c.services.projects.createProject({ commandId: "p1", actor: owner.id, name: "Garden" })).id;
    await c.services.principals.enroll(owner, { commandId: "e-ann", kind: "agent", name: "ann", grants: [] });
    const ann = (await c.services.principals.issueCredential(owner, "agent:ann")).token;
    const events = EventService.withEpoch(c.storage, c.epoch, { clock });
    const stream = `project:${project}`;
    const call = (token: string, op: string, args: Record<string, unknown>, commandId?: string) => c.api.handle(token, { v: 1, op, ...(commandId === undefined ? {} : { commandId }), args } as never) as Promise<{ ok: boolean; result?: any; error?: { code: string } }>;
    const notices = async () => (await c.storage.listAggregates("notification-item", { limit: 50 })).filter((n) => JSON.stringify(n.body).includes("stopped acknowledging")).length;

    // The owner sets the idle time through the API; nobody else may.
    assert.equal((await call(ann, "events.configure-idle", { idleSeconds: 60 }, "ci-ann")).error?.code, "forbidden");
    assert.ok((await call(boot.token, "events.configure-idle", { idleSeconds: 60 }, "ci")).ok);
    assert.equal((await call(boot.token, "events.configure-idle", { idleSeconds: 1 }, "ci-bad")).ok, false);
    // A subscription made without its own idle time uses the owner's (this is also how one that predates idle expiry is covered). Events are waiting for it.
    const sub = await events.subscribe(owner, { commandId: "sb1", stream, fromStart: true });
    await events.publish(owner, { commandId: "pb1", stream, kind: "task.updated", ref: { kind: "task", id: "task-aaaaaaaaaaaaaaaaaaaa" } } as never);
    await c.dispatch.dispatcher.tick();
    assert.equal(await notices(), 0, "not idle yet");
    now += 61_000;
    await c.dispatch.dispatcher.tick();
    assert.equal((await events.status(owner, sub.id)).state, "expired");
    assert.equal(await notices(), 1, "one notice for the expiry");
    now += 61_000;
    await c.dispatch.dispatcher.tick(); await c.dispatch.dispatcher.tick();
    assert.equal(await notices(), 1, "and not another at the next ticks");
    const [activity] = (await c.storage.listAudit({ afterSeq: 0, limit: 1000 })).filter((e) => e.type === "events.expire");
    assert.ok(activity !== undefined, "the expiry is in the activity record");

    // A subscription that predates idle expiry (no last activity recorded, made long ago) is not expired at the first tick after upgrade: its idle time counts from the stamp at start.
    const legacy = await events.subscribe(owner, { commandId: "sb-old", stream });
    const rec = (await c.storage.getAggregate({ kind: "subscription", id: legacy.id }))!;
    const { lastActiveAt: _drop, ...old } = rec.body as Record<string, unknown>;
    await c.storage.applyOperation({ operationId: "op-legacy", epoch: c.epoch, actor: "test", correlationId: "cor-legacy", at: clock(), changes: [{ type: "update", ref: { kind: "subscription", id: legacy.id }, expectedRevision: rec.revision, body: { ...old, createdAt: "2026-01-01T00:00:00.000Z" } as never }], audit: [], outbox: [], effects: [], timers: [], cancelTimers: [], completeDeliveries: [], completeTimers: [], settleEffects: [] } as never);
    const service = await c.services.principals.authenticate((await c.services.principals.provisionService("dispatcher")).token);
    assert.deepEqual(await events.stampIdle(service), { stamped: 1 });
    assert.deepEqual(await events.stampIdle(service), { stamped: 0 }, "once");
    await c.dispatch.dispatcher.tick();
    assert.equal((await events.status(owner, legacy.id)).state, "active", "not expired by the first sweep");
    now += 61_000;
    await c.dispatch.dispatcher.tick();
    assert.equal((await events.status(owner, legacy.id)).state, "expired", "idle for the idle time from the stamp");

    // Cancelling: the subscriber or the owner may, another agent may not.
    const other = await events.subscribe(owner, { commandId: "sb2", stream });
    assert.equal((await call(ann, "events.cancel", { subscriptionId: other.id }, "cn-ann")).error?.code, "forbidden");
    assert.ok((await call(boot.token, "events.cancel", { subscriptionId: other.id }, "cn")).ok);
    assert.equal((await events.status(owner, other.id)).state, "cancelled");
  } finally { await c.close(); rmSync(d, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }); }
});

test("a subscription made before idle expiry existed is not expired by the first tick after a restart; its idle time counts from the start (card H06c)", async () => {
  const d = mkdtempSync(join(tmpdir(), "nn-events-"));
  let now = Date.parse("2026-10-27T10:00:00.000Z");
  const clock = (): string => new Date(now).toISOString();
  const file = join(d, "c.sqlite");
  const open = () => startController({ storage: { kind: "sqlite", path: file }, argv: [], env: {}, print: () => undefined, facts: supported, filesystem: ext4, features: [], dispatch: { timer: new ManualTimer(), manual: true, clock } });
  let c = await open();
  let token: string;
  let id: string;
  let stream: string;
  try {
    const boot = await c.services.principals.bootstrapOwner({ name: "rob" });
    token = boot.token;
    const owner = await c.services.principals.authenticate(boot.token);
    const project = (await c.services.projects.createProject({ commandId: "p1", actor: owner.id, name: "Garden" })).id;
    stream = `project:${project}`;
    const events = EventService.withEpoch(c.storage, c.epoch, { clock });
    id = (await events.subscribe(owner, { commandId: "sb-old", stream })).id;
    await events.publish(owner, { commandId: "pb-old", stream, kind: "task.updated", ref: { kind: "task", id: "task-aaaaaaaaaaaaaaaaaaaa" } } as never);
    // Make it look like a record from before idle expiry: no last activity, made long ago.
    const rec = (await c.storage.getAggregate({ kind: "subscription", id }))!;
    const { lastActiveAt: _drop, ...old } = rec.body as Record<string, unknown>;
    await c.storage.applyOperation({ operationId: "op-legacy", epoch: c.epoch, actor: "test", correlationId: "cor-legacy", at: clock(), changes: [{ type: "update", ref: { kind: "subscription", id }, expectedRevision: rec.revision, body: { ...old, createdAt: "2026-01-01T00:00:00.000Z" } as never }], audit: [], outbox: [], effects: [], timers: [], cancelTimers: [], completeDeliveries: [], completeTimers: [], settleEffects: [] } as never);
  } finally { await c.close(); }
  try {
    c = await open();
    assert.ok(c.dispatch !== undefined, c.dispatchProblem);
    const owner = await c.services.principals.authenticate(token!);
    const events = EventService.withEpoch(c.storage, c.epoch, { clock });
    assert.ok((await c.storage.getAggregate({ kind: "subscription", id: id! }))!.body["lastActiveAt" as never] !== undefined, "stamped at start");
    await c.dispatch.dispatcher.tick();
    assert.equal((await events.status(owner, id!)).state, "active", "the first tick after the restart does not expire it");
    now += 901_000;
    await c.dispatch.dispatcher.tick();
    assert.equal((await events.status(owner, id!)).state, "expired", "after the default idle time from the start");
  } finally { await c.close(); rmSync(d, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }); }
});
