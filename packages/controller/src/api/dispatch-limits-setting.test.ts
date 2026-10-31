import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { CHAT_OPS } from "../chat/commands.js";
import { ManualTimer } from "../dispatch/testing/timer.js";
import type { EnvironmentFacts, FilesystemDetector } from "../environment/index.js";
import { startController } from "./index.js";

const ext4: FilesystemDetector = async () => ({ type: "ext4", network: false });
const supported: EnvironmentFacts = { platform: "linux", arch: "x64", osRelease: "6.8.0-generic", nodeVersion: "22.19.0" };

test("the owner sets the dispatcher's time and attempt limits: off by default, owner only, validated, merge-style, race-safe, replay-safe, enable/disable keeps the figure", async () => {
  const d = mkdtempSync(join(tmpdir(), "nn-dlim-"));
  const c = await startController({
    storage: { kind: "sqlite", path: join(d, "c.sqlite") }, argv: [], env: {}, print: () => undefined, facts: supported, filesystem: ext4, features: [],
    dispatch: { timer: new ManualTimer(), manual: true, dispatcher: { maxAttempts: 7 } },
  } as never);
  try {
    const boot = await c.services.principals.bootstrapOwner({ name: "rob" });
    const rob = await c.services.principals.authenticate(boot.token);
    await c.services.principals.enroll(rob, { commandId: "e-ann", kind: "agent", name: "agt-abcdefghijklmnopqrst", grants: [] });
    const ann = (await c.services.principals.issueCredential(rob, "agent:agt-abcdefghijklmnopqrst")).token;
    const call = (token: string, op: string, args: Record<string, unknown>, commandId?: string) => c.api.handle(token, { v: 1, op, ...(commandId === undefined ? {} : { commandId }), args } as never) as Promise<{ ok: boolean; result?: any; error?: { code: string } }>;
    const get = async () => (await call(boot.token, "dispatch.limits.get", {})).result.item;

    const first = await get();
    assert.deepEqual([first.revision, first.limits, first.effective, first.startup], [0, {}, { maxAttempts: 7 }, { maxAttempts: 7 }], "no attempt time limit unless set; the start-up option shows through");
    assert.equal((await call(ann, "dispatch.limits.get", {})).error?.code, "forbidden");
    assert.equal((await call(ann, "dispatch.limits.change", { set: { attemptMinutes: 5 } }, "d0")).error?.code, "forbidden");
    for (const [i, bad] of ([{ attemptMinutes: 0 }, { attemptMinutes: 1.5 }, { attemptMinutes: "4h" }, { maxAttempts: 1001 }, { hours: 4 }, [1]] as unknown[]).entries()) {
      assert.equal((await call(boot.token, "dispatch.limits.change", { set: bad }, `db${i}`)).error?.code, "invalid_command", JSON.stringify(bad));
    }
    for (const [i, args] of ([{}, { enable: ["attemptMinutes"] }, { disable: ["nope"] }, { set: { maxAttempts: 2 }, unset: ["maxAttempts"] }, { unset: "maxAttempts" }, { extra: 1, set: { maxAttempts: 2 } }] as Record<string, unknown>[]).entries()) {
      assert.equal((await call(boot.token, "dispatch.limits.change", args, `dc${i}`)).error?.code, "invalid_command", JSON.stringify(args));
    }
    assert.equal((await get()).revision, 0, "refused changes change nothing");

    const on = await call(boot.token, "dispatch.limits.change", { set: { attemptMinutes: 240 } }, "d1");
    assert.ok(on.ok, JSON.stringify(on));
    assert.deepEqual((await get()).effective, { attemptMinutes: 240, maxAttempts: 7 }, "merge-style: the attempt limit is on, the other figure is untouched");
    assert.equal((await call(boot.token, "dispatch.limits.change", { set: { attemptMinutes: 240 } }, "d1")).result.revision, on.result.revision, "same command ID is the same change");
    assert.equal((await call(boot.token, "dispatch.limits.change", { set: { maxAttempts: 3 }, expectedRevision: 0 }, "d2")).error?.code, "stale_revision");
    assert.ok((await call(boot.token, "dispatch.limits.change", { set: { maxAttempts: 3 }, expectedRevision: on.result.revision }, "d3")).ok);
    assert.deepEqual((await get()).effective, { attemptMinutes: 240, maxAttempts: 3 }, "the owner's figure wins over start-up");
    // Off keeps the figure; the start-up option does not come back through an explicit off.
    assert.ok((await call(boot.token, "dispatch.limits.change", { disable: ["attemptMinutes", "maxAttempts"] }, "d4")).ok);
    const off = await get();
    assert.deepEqual([off.effective, off.limits.attemptMinutes, off.limits.maxAttempts], [{}, { enabled: false, value: 240 }, { enabled: false, value: 3 }]);
    assert.ok((await call(boot.token, "dispatch.limits.change", { enable: ["attemptMinutes"] }, "d5")).ok);
    assert.deepEqual((await get()).effective, { attemptMinutes: 240 }, "turned on again with the kept figure");
    // null in set also turns off.
    assert.ok((await call(boot.token, "dispatch.limits.change", { set: { attemptMinutes: null } }, "d6")).ok);
    assert.deepEqual((await get()).effective, {});
    // unset forgets the entry: the start-up option applies again.
    assert.ok((await call(boot.token, "dispatch.limits.change", { unset: ["maxAttempts", "attemptMinutes"] }, "d7")).ok);
    assert.deepEqual((await get()).effective, { maxAttempts: 7 });
    assert.ok("dispatch.limits.change" in CHAT_OPS, "the chat can propose it");
    assert.equal(CHAT_OPS["dispatch.limits.change"]!.mode, "propose");
  } finally {
    await c.close();
    rmSync(d, { recursive: true, force: true });
  }
});
