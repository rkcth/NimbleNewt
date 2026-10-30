import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { EnvironmentFacts, FilesystemDetector } from "../environment/index.js";
import { startController } from "./index.js";

const ext4: FilesystemDetector = async () => ({ type: "ext4", network: false });
const supported: EnvironmentFacts = { platform: "linux", arch: "x64", osRelease: "6.8.0-generic", nodeVersion: "22.19.0" };

test("the owner reads and sets notification settings through the state API, a stale revision, an agent and a bad escalation time are refused (card U11b)", async () => {
  const d = mkdtempSync(join(tmpdir(), "nn-ntfset-"));
  const c = await startController({ storage: { kind: "sqlite", path: join(d, "c.sqlite") }, argv: [], env: {}, print: () => undefined, facts: supported, filesystem: ext4 });
  try {
    const boot = await c.services.principals.bootstrapOwner({ name: "rob" });
    const rob = await c.services.principals.authenticate(boot.token);
    await c.services.principals.enroll(rob, { commandId: "e-ann", kind: "agent", name: "ann", grants: [] });
    const ann = (await c.services.principals.issueCredential(rob, "agent:ann")).token;
    const call = (token: string, op: string, args: Record<string, unknown>, commandId?: string) => c.api.handle(token, { v: 1, op, ...(commandId === undefined ? {} : { commandId }), args } as never) as Promise<{ ok: boolean; result: any; error?: { code: string } }>;

    const first = await call(boot.token, "notifications.settings", {});
    assert.ok(first.ok, JSON.stringify(first));
    const set = await call(boot.token, "notifications.configure", { digestTimes: ["08:00", "17:00"], quietHours: { start: "22:00", end: "07:00" }, escalateAfterHours: 48, expectedRevision: first.result.item.revision }, "ns1");
    assert.ok(set.ok, JSON.stringify(set));
    const read = (await call(boot.token, "notifications.settings", {})).result.item;
    assert.equal(read.escalateAfterHours, 48);
    assert.deepEqual(read.digestTimes, ["08:00", "17:00"]);
    assert.equal(read.revision, set.result.revision);

    assert.equal((await call(boot.token, "notifications.configure", { escalateAfterHours: 12, expectedRevision: first.result.item.revision }, "ns2")).error?.code, "stale_revision");
    assert.equal((await call(boot.token, "notifications.configure", { escalateAfterHours: 0, expectedRevision: read.revision }, "ns3")).error?.code, "invalid_command");
    assert.equal((await call(boot.token, "notifications.configure", { escalateAfterHours: 721, expectedRevision: read.revision }, "ns4")).error?.code, "invalid_command");
    assert.equal((await call(ann, "notifications.configure", { escalateAfterHours: 12, expectedRevision: read.revision }, "ns5")).error?.code, "forbidden");
    assert.equal((await call(ann, "notifications.settings", {})).error?.code, "forbidden");
    assert.equal((await call(boot.token, "notifications.settings", {})).result.item.escalateAfterHours, 48, "refused commands changed nothing");
  } finally { await c.close(); rmSync(d, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }); }
});
