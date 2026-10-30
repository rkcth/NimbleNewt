import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { ManualTimer } from "../dispatch/testing/timer.js";
import type { EnvironmentFacts, FilesystemDetector } from "../environment/index.js";
import { startController } from "./index.js";
import { defaultWorkspaceLimits } from "./worker-limits.js";

const ext4: FilesystemDetector = async () => ({ type: "ext4", network: false });
const supported: EnvironmentFacts = { platform: "linux", arch: "x64", osRelease: "6.8.0-generic", nodeVersion: "22.19.0" };

test("defaultWorkspaceLimits: the owner's figures win per figure over start-up, nothing set gives undefined, a bad figure throws (card H12k)", () => {
  assert.equal(defaultWorkspaceLimits(undefined, undefined), undefined);
  assert.equal(defaultWorkspaceLimits({}, {}), undefined);
  assert.deepEqual(defaultWorkspaceLimits({ cpus: 2, memoryMb: 1024 }, undefined), { cpus: 2, memoryMb: 1024 });
  assert.deepEqual(defaultWorkspaceLimits({ cpus: 2, memoryMb: 1024 }, { memoryMb: 4096, processes: 64 }), { cpus: 2, memoryMb: 4096, processes: 64 });
  assert.throws(() => defaultWorkspaceLimits({ cpus: 2 }, { cpus: 0 }), /cpus/);
});

test("the owner sets the limits for local agents: owner only, validated, race-safe, read fresh by the host builder at each launch (card H12k)", async () => {
  const d = mkdtempSync(join(tmpdir(), "nn-wlim-"));
  let currentLimits: (() => Promise<unknown>) | undefined;
  const c = await startController({
    storage: { kind: "sqlite", path: join(d, "c.sqlite") }, argv: [], env: {}, print: () => undefined, facts: supported, filesystem: ext4, features: [],
    dispatch: { timer: new ManualTimer(), manual: true, local: { window: () => 8192, limits: { cpus: 2, memoryMb: 2048 }, close: async () => undefined, build: (s: { currentLimits: () => Promise<unknown> }) => { currentLimits = s.currentLimits; return { hostId: "host:w1" } as never; } } },
  } as never);
  try {
    const boot = await c.services.principals.bootstrapOwner({ name: "rob" });
    const rob = await c.services.principals.authenticate(boot.token);
    await c.services.principals.enroll(rob, { commandId: "e-ann", kind: "agent", name: "agt-abcdefghijklmnopqrst", grants: [] });
    const ann = (await c.services.principals.issueCredential(rob, "agent:agt-abcdefghijklmnopqrst")).token;
    const call = (token: string, op: string, args: Record<string, unknown>, commandId?: string) => c.api.handle(token, { v: 1, op, ...(commandId === undefined ? {} : { commandId }), args } as never) as Promise<{ ok: boolean; result?: any; error?: { code: string } }>;

    assert.deepEqual(await currentLimits!(), { cpus: 2, memoryMb: 2048 }, "nothing set: the start-up figures");
    const first = (await call(boot.token, "workers.limits.get", {})).result.item;
    assert.deepEqual([first.revision, first.limits, first.effective], [0, {}, { cpus: 2, memoryMb: 2048 }]);

    assert.equal((await call(ann, "workers.limits.get", {})).error?.code, "forbidden");
    assert.equal((await call(ann, "workers.limits.set", { limits: { cpus: 1 } }, "w0")).error?.code, "forbidden");
    for (const [i, bad] of ([{ cpus: 0 }, { cpus: 1.5 }, { memoryMb: "1g" }, { gpus: 1 }, [1], null, { diskMb: 99_999_999_999 }] as unknown[]).entries()) {
      assert.equal((await call(boot.token, "workers.limits.set", { limits: bad }, `wb${i}`)).error?.code, "invalid_command", JSON.stringify(bad));
    }
    assert.equal((await call(boot.token, "workers.limits.set", {}, "wn")).error?.code, "invalid_command", "limits are required");
    assert.deepEqual(await currentLimits!(), { cpus: 2, memoryMb: 2048 }, "refused sets change nothing");

    const set = await call(boot.token, "workers.limits.set", { limits: { memoryMb: 4096, processes: 64 } }, "w1");
    assert.ok(set.ok, JSON.stringify(set));
    assert.deepEqual(await currentLimits!(), { cpus: 2, memoryMb: 4096, processes: 64 }, "the next launch sees the owner's figures over start-up");
    const replay = await call(boot.token, "workers.limits.set", { limits: { memoryMb: 4096, processes: 64 } }, "w1");
    assert.equal(replay.result.revision, set.result.revision, "same command ID is the same change");
    assert.equal((await call(boot.token, "workers.limits.set", { limits: { cpus: 4 }, expectedRevision: 0 }, "w2")).error?.code, "stale_revision");
    assert.ok((await call(boot.token, "workers.limits.set", { limits: { cpus: 4 }, expectedRevision: set.result.revision }, "w3")).ok);
    assert.deepEqual(await currentLimits!(), { cpus: 4, memoryMb: 2048 }, "the setting replaces the earlier setting, not merged with it");
    assert.ok((await call(boot.token, "workers.limits.set", { limits: {} }, "w4")).ok);
    assert.deepEqual(await currentLimits!(), { cpus: 2, memoryMb: 2048 }, "empty clears: start-up applies");
  } finally {
    await c.close();
    rmSync(d, { recursive: true, force: true });
  }
});
