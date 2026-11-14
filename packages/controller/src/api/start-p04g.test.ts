import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { ManualTimer } from "../dispatch/testing/timer.js";
import { PI } from "../dispatch/testing/world.js";
import type { EnvironmentFacts, FilesystemDetector } from "../environment/index.js";
import { CoverageGapService } from "../projects/index.js";
import { startController } from "./index.js";

const ext4: FilesystemDetector = async () => ({ type: "ext4", network: false });
const supported: EnvironmentFacts = { platform: "linux", arch: "x64", osRelease: "6.8.0-generic", nodeVersion: "22.19.0" };
type Reply = { ok: boolean; result?: any; error?: { code: string } };

test("through the running controller: a lease that ran out unreleased reaches the owner once; a missing check shows the coverage gap next to a state that stays unknown (card P04g)", async () => {
  const d = mkdtempSync(join(tmpdir(), "nn-p04g-"));
  const c = await startController({ storage: { kind: "sqlite", path: join(d, "c.sqlite") }, argv: [], env: {}, print: () => undefined, facts: supported, filesystem: ext4, features: [], harnesses: [PI], dispatch: { timer: new ManualTimer(), intervalMs: 1000 } });
  try {
    assert.ok(c.dispatch !== undefined, c.dispatchProblem);
    const boot = await c.services.principals.bootstrapOwner({ name: "rob" });
    const owner = await c.services.principals.authenticate(boot.token);
    const call = (op: string, args: Record<string, unknown>, commandId?: string) => c.api.handle(boot.token, { v: 1, op, ...(commandId === undefined ? {} : { commandId }), args } as never) as Promise<Reply>;
    const project = (await call("project.create", { name: "Ops" }, "p1")).result.id as string;
    const res = (await call("resource.bind", { projectId: project, kind: "service", label: "Web", locator: "https://example.test" }, "b1")).result.id as string;
    const duty = (await call("responsibility.create", { projectId: project, title: "Keep web up", objective: "Up", everyMinutes: 60, managed: [res], escalation: { to: "owner" } }, "r1")).result.id as string;
    const notices = async () => (await c.storage.listAggregates("notification-item", { limit: 100 })).filter((a) => JSON.stringify(a.body).includes("maintenance lease"));
    const tickN = async (k = 3): Promise<void> => { for (let i = 0; i < k; i++) await c.dispatch!.dispatcher.tick(); };

    assert.equal((await call("lease.acquire", { resourceId: res, purpose: "upgrade", minutes: 30 }, "a1")).result.status, "granted");
    await tickN();
    assert.equal((await notices()).length, 0, "a live lease tells nothing");
    // Age the lease: its time ran out 10 minutes ago and nobody released it.
    const lease = (await c.storage.listAggregates("maintenance-lease", { limit: 5 }))[0]!;
    await c.storage.applyOperation({ operationId: "age", epoch: c.epoch, actor: "owner:rob", correlationId: "age", at: new Date().toISOString(), changes: [{ type: "update", ref: { kind: "maintenance-lease", id: lease.id }, expectedRevision: lease.revision, body: { ...(lease.body as object), expiresAt: new Date(Date.now() - 10 * 60_000).toISOString() } }], audit: [], outbox: [], effects: [], timers: [], cancelTimers: [], completeDeliveries: [], completeTimers: [], settleEffects: [] } as never);
    await tickN();
    assert.equal((await notices()).length, 1, "the owner was told once");
    await tickN();
    assert.equal((await notices()).length, 1, "not told again on later ticks");
    assert.equal((await call("lease.list", { projectId: project })).result.items[0].status, "expired", "telling does not release it");
    // Another holding that also runs out is a new notice.
    assert.equal((await call("lease.acquire", { resourceId: res, purpose: "again", minutes: 30 }, "a2")).result.status, "granted");

    // A check is missing and a gap overlaps the time since the responsibility began: it is listed next to the state, which stays unknown.
    const before = (await call("responsibility.observed", { responsibilityId: duty })).result.item;
    assert.deepEqual([before.observed, before.coverageGaps], ["unknown", []]);
    await CoverageGapService.withEpoch(c.storage, c.epoch).open(owner, { key: "provider:model:m1", reason: "provider-outage", start: new Date(Date.now() - 5 * 60_000).toISOString(), detail: "model route down" } as never);
    const during = (await call("responsibility.observed", { responsibilityId: duty })).result.item;
    assert.equal(during.observed, "unknown", "a gap never makes it healthy");
    assert.deepEqual(during.coverageGaps.map((g: any) => [g.reason, g.end]), [["provider-outage", undefined]]);
    // A gap already over still explains the missing check (it overlaps the time since the responsibility began).
    const began = (await call("responsibility.get", { responsibilityId: duty })).result.item.createdAt as string;
    await CoverageGapService.withEpoch(c.storage, c.epoch).record(owner, { key: "events:old", reason: "events-missed", start: began, end: new Date(Date.parse(began) + 1).toISOString(), detail: "events lost" } as never);
    const after = (await call("responsibility.observed", { responsibilityId: duty })).result.item;
    assert.deepEqual(after.coverageGaps.map((g: any) => g.reason).sort(), ["events-missed", "provider-outage"]);
  } finally { await c.close(); rmSync(d, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }); }
});
