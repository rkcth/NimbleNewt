import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { EnvironmentFacts, FilesystemDetector } from "../environment/index.js";
import { startController } from "./index.js";

const ext4: FilesystemDetector = async () => ({ type: "ext4", network: false });
const supported: EnvironmentFacts = { platform: "linux", arch: "x64", osRelease: "6.8.0-generic", nodeVersion: "22.19.0" };

test("resume.settings.get/set through the API: owner only, validated, replay-safe, race-safe; chat proposes it", async () => {
  const d = mkdtempSync(join(tmpdir(), "nn-rset-"));
  const c = await startController({ storage: { kind: "sqlite", path: join(d, "c.sqlite") }, argv: [], env: {}, print: () => undefined, facts: supported, filesystem: ext4, features: [] } as never);
  try {
    const boot = await c.services.principals.bootstrapOwner({ name: "rob" });
    const rob = await c.services.principals.authenticate(boot.token);
    await c.services.principals.enroll(rob, { commandId: "e-ann", kind: "agent", name: "agt-abcdefghijklmnopqrst", grants: [] });
    const ann = (await c.services.principals.issueCredential(rob, "agent:agt-abcdefghijklmnopqrst")).token;
    const call = (token: string, op: string, args: Record<string, unknown>, commandId?: string) => c.api.handle(token, { v: 1, op, ...(commandId === undefined ? {} : { commandId }), args } as never) as Promise<{ ok: boolean; result?: any; error?: { code: string } }>;
    const g0 = (await call(boot.token, "resume.settings.get", {})).result.item;
    assert.deepEqual([g0.revision, g0.maxRounds, g0.default, g0.effective], [0, null, 3, 3]);
    assert.equal((await call(ann, "resume.settings.get", {})).error?.code, "forbidden");
    assert.equal((await call(ann, "resume.settings.set", { maxRounds: 5 }, "r0")).error?.code, "forbidden");
    for (const [i, bad] of ([0, 11, 1.5, "3", undefined] as unknown[]).entries()) assert.equal((await call(boot.token, "resume.settings.set", { maxRounds: bad }, `rb${i}`)).error?.code, "invalid_command", String(bad));
    const set = await call(boot.token, "resume.settings.set", { maxRounds: 6 }, "r1");
    assert.ok(set.ok, JSON.stringify(set));
    assert.equal((await call(boot.token, "resume.settings.set", { maxRounds: 6 }, "r1")).result.revision, set.result.revision);
    assert.equal((await call(boot.token, "resume.settings.set", { maxRounds: 2, expectedRevision: 0 }, "r2")).error?.code, "stale_revision");
    assert.equal((await call(boot.token, "resume.settings.get", {})).result.item.effective, 6);
    assert.ok((await call(boot.token, "resume.settings.set", { maxRounds: null, expectedRevision: set.result.revision }, "r3")).ok);
    assert.equal((await call(boot.token, "resume.settings.get", {})).result.item.effective, 3);
  } finally { await c.close(); rmSync(d, { recursive: true, force: true }); }
});
