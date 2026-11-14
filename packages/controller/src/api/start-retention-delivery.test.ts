import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { ManualTimer } from "../dispatch/testing/timer.js";
import type { EnvironmentFacts, FilesystemDetector } from "../environment/index.js";
import { startController } from "./index.js";

const ext4: FilesystemDetector = async () => ({ type: "ext4", network: false });
const supported: EnvironmentFacts = { platform: "linux", arch: "x64", osRelease: "6.8.0-generic", nodeVersion: "22.19.0" };
type Reply = { ok: boolean; result?: any; error?: { code: string } };
const DAY = 86_400_000;

// Card K06b: the owner sets the bulk-log tier by chat or the API; it is owner-only, bounded, recorded with old and new value, and shows in the status; the running controller removes exactly the delivered records.
test("deliveryLogDays: owner-only, bounded, recorded; the running controller previews and removes delivered message records only (card K06b)", async () => {
  const d = mkdtempSync(join(tmpdir(), "nn-ret-dlv-"));
  const c = await startController({ storage: { kind: "sqlite", path: join(d, "c.sqlite") }, argv: [], env: {}, print: () => undefined, facts: supported, filesystem: ext4, features: [], harnesses: [], dispatch: { timer: new ManualTimer(), intervalMs: 1000 }, retention: { defaults: { reserveBytes: 0 }, autoEveryMs: 0 } } as never);
  try {
    const boot = await c.services.principals.bootstrapOwner({ name: "rob" });
    const call = (token: string, op: string, args: Record<string, unknown>, commandId?: string) => c.api.handle(token, { v: 1, op, ...(commandId === undefined ? {} : { commandId }), args } as never) as Promise<Reply>;
    const put = async (id: string, state: string, daysAgo: number) => { const op = `put:${id}`; await c.storage.applyOperation({ operationId: op, epoch: c.epoch, actor: "test", correlationId: op, at: new Date(Date.now() - daysAgo * DAY).toISOString(), changes: [{ type: "create", ref: { kind: "notification-delivery", id }, body: { subject: { kind: "item", id: "ntf-x" }, channel: "mail", text: "message text", state, attempts: 1 } as never }], audit: [{ type: "test.put", subject: { kind: "notification-delivery", id }, detail: {} }], outbox: [], effects: [], timers: [], cancelTimers: [], completeDeliveries: [], completeTimers: [], settleEffects: [] } as never); };
    await put("ndl-a", "delivered", 100); await put("ndl-b", "failed", 100); await put("ndl-c", "delivered", 1);

    const g0 = (await call(boot.token, "retention.settings.get", {})).result.item;
    assert.equal(g0.effective.deliveryLogDays, null, "off by default");
    for (const bad of [6, 3651, "30", 1.5]) assert.equal((await call(boot.token, "retention.settings.set", { deliveryLogDays: bad }, `bad-${bad}`)).error?.code, "invalid_command", String(bad));
    const set = await call(boot.token, "retention.settings.set", { deliveryLogDays: 30 }, "set-1");
    assert.ok(set.ok, JSON.stringify(set)); assert.match(JSON.stringify(set.result), /deliveryLogDays none -> 30/);
    const status = (await call(boot.token, "retention.status", {})).result.item;
    assert.equal(status.growth["notification-delivery"], 3);

    const preview = (await call(boot.token, "retention.run", {}, "run-0")).result;
    assert.deepEqual(preview.candidates.map((x: { id: string }) => x.id), ["ndl-a"]);
    const real = (await call(boot.token, "retention.run", { dryRun: false, confirm: preview.digest }, "run-1")).result;
    assert.equal(real.removed, 1);
    assert.equal((await c.storage.getAggregate({ kind: "notification-delivery", id: "ndl-a" })), undefined);
    for (const id of ["ndl-b", "ndl-c"]) assert.ok(await c.storage.getAggregate({ kind: "notification-delivery", id }), id);
    const audit = await c.storage.listAudit({ afterSeq: 0, limit: 1000 });
    assert.ok(audit.some((e) => e.type === "retention.settings" || /deliveryLogDays/.test(JSON.stringify(e))), "the tier change is recorded");
    assert.equal((await call(boot.token, "retention.settings.set", { deliveryLogDays: null }, "set-2")).ok, true, "and off again");
    assert.equal((await call("not-a-token", "retention.settings.set", { deliveryLogDays: 30 }, "x")).ok, false);
  } finally { await c.close(); rmSync(d, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }); }
});
