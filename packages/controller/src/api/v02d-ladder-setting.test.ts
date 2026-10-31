import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { ManualTimer } from "../dispatch/testing/timer.js";
import type { EnvironmentFacts, FilesystemDetector } from "../environment/index.js";
import { CHAT_OPS } from "../chat/commands.js";
import { startController } from "./index.js";

const ext4: FilesystemDetector = async () => ({ type: "ext4", network: false });
const supported: EnvironmentFacts = { platform: "linux", arch: "x64", osRelease: "6.8.0-generic", nodeVersion: "22.19.0" };

test("the owner sets how long a stall concern waits at each level of the supervisor ladder: owner only, bounded, race-safe, replay-safe, read by the stall service (owner decision 2026-10-30, supervisor ladder)", async () => {
  const d = mkdtempSync(join(tmpdir(), "nn-ladder-"));
  const c = await startController({
    storage: { kind: "sqlite", path: join(d, "c.sqlite") }, argv: [], env: {}, print: () => undefined, facts: supported, filesystem: ext4, features: [],
    dispatch: { timer: new ManualTimer(), manual: true },
  } as never);
  try {
    const boot = await c.services.principals.bootstrapOwner({ name: "rob" });
    const rob = await c.services.principals.authenticate(boot.token);
    await c.services.principals.enroll(rob, { commandId: "e-ann", kind: "agent", name: "agt-abcdefghijklmnopqrst", grants: [] });
    const ann = (await c.services.principals.issueCredential(rob, "agent:agt-abcdefghijklmnopqrst")).token;
    const call = (token: string, op: string, args: Record<string, unknown>, commandId?: string) => c.api.handle(token, { v: 1, op, ...(commandId === undefined ? {} : { commandId }), args } as never) as Promise<{ ok: boolean; result?: any; error?: { code: string } }>;

    const first = (await call(boot.token, "escalation.ladder.get", {})).result.item;
    assert.deepEqual([first.revision, first.hours, first.defaultHours], [0, [], 24]);
    assert.equal((await call(ann, "escalation.ladder.get", {})).error?.code, "forbidden");
    assert.equal((await call(ann, "escalation.ladder.set", { hours: [1] }, "l0")).error?.code, "forbidden");
    const bad: unknown[] = [[0], [721], [1.5], ["24"], [-1], Array.from({ length: 17 }, () => 24), "24", null, { 0: 24 }, [Number.NaN], [null]];
    for (const [i, hours] of bad.entries()) assert.equal((await call(boot.token, "escalation.ladder.set", { hours }, `lb${i}`)).error?.code, "invalid_command", JSON.stringify(hours));
    assert.equal((await call(boot.token, "escalation.ladder.set", {}, "ln")).error?.code, "invalid_command", "hours are required");
    assert.equal((await call(boot.token, "escalation.ladder.set", { hours: [24], extra: 1 }, "lx")).error?.code, "invalid_command");
    assert.equal((await call(boot.token, "escalation.ladder.get", {})).result.item.revision, 0, "refused sets change nothing");

    const set = await call(boot.token, "escalation.ladder.set", { hours: [1, 720, 48] }, "l1");
    assert.ok(set.ok, JSON.stringify(set));
    assert.deepEqual((await call(boot.token, "escalation.ladder.get", {})).result.item.hours, [1, 720, 48]);
    assert.equal((await call(boot.token, "escalation.ladder.set", { hours: [1, 720, 48] }, "l1")).result.revision, set.result.revision, "the same command ID is the same change");
    assert.equal((await call(boot.token, "escalation.ladder.set", { hours: [5] }, "l1")).error?.code, "command_conflict", "the same ID with other contents is refused");
    assert.equal((await call(boot.token, "escalation.ladder.set", { hours: [5], expectedRevision: 0 }, "l2")).error?.code, "stale_revision");
    assert.ok((await call(boot.token, "escalation.ladder.set", { hours: [5], expectedRevision: set.result.revision }, "l3")).ok);
    assert.deepEqual((await call(boot.token, "escalation.ladder.get", {})).result.item.hours, [5], "the list replaces the earlier one");
    assert.ok((await call(boot.token, "escalation.ladder.set", { hours: [] }, "l4")).ok);
    assert.deepEqual((await call(boot.token, "escalation.ladder.get", {})).result.item.hours, [], "an empty list clears it");
    assert.equal(CHAT_OPS["escalation.ladder.set"]?.mode, "propose", "chat shows the owner the change first");
  } finally {
    await c.close();
    rmSync(d, { recursive: true, force: true });
  }
});
