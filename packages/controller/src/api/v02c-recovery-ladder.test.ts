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

test("the owner sets which recovery actions are allowed at which level, and switches agents' recovery steps on and off: owner only, bounded, race-safe, replay-safe; chat shows changes first (card V02c)", async () => {
  const d = mkdtempSync(join(tmpdir(), "nn-recovery-"));
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
    const first = (await call(boot.token, "recovery.ladder.get", {})).result.item;
    assert.deepEqual([first.revision, first.enabled, first.levels], [0, true, []]);
    assert.deepEqual(first.defaults.first, ["nudge", "rebrief", "hand-to-owner"]);
    for (const op of ["recovery.ladder.get"]) assert.equal((await call(ann, op, {})).error?.code, "forbidden");
    for (const [i, op] of ["recovery.ladder.set", "recovery.ladder.enable", "recovery.ladder.disable"].entries()) assert.equal((await call(ann, op, op.endsWith("set") ? { enabled: false } : {}, `a${i}`)).error?.code, "forbidden", op);
    assert.equal((await call(ann, "recovery.step", { concernId: "stl-x", expectedRevision: 1, action: "nudge", text: "hi" }, "s0")).error?.code, "not_found", "a concern nobody can see reads like a missing one");
    const bad: Record<string, unknown>[] = [{}, { levels: "nudge" }, { levels: [["fly"]] }, { levels: [["nudge"], "x"] }, { levels: Array.from({ length: 17 }, () => []) }, { owner: [3] }, { enabled: "yes" }, { levels: [], extra: 1 }];
    for (const [i, args] of bad.entries()) assert.equal((await call(boot.token, "recovery.ladder.set", args, `b${i}`)).error?.code, "invalid_command", JSON.stringify(args));
    assert.equal((await call(boot.token, "recovery.ladder.get", {})).result.item.revision, 0, "refused sets change nothing");
    const set = await call(boot.token, "recovery.ladder.set", { levels: [["nudge"], ["nudge", "pause", "pause"]], owner: ["stop"] }, "r1");
    assert.ok(set.ok, JSON.stringify(set));
    const got = (await call(boot.token, "recovery.ladder.get", {})).result.item;
    assert.deepEqual([got.levels, got.owner, got.enabled], [[["nudge"], ["nudge", "pause"]], ["stop"], true]);
    assert.equal((await call(boot.token, "recovery.ladder.set", { levels: [["nudge"], ["nudge", "pause", "pause"]], owner: ["stop"] }, "r1")).result.revision, set.result.revision, "the same command ID is the same change");
    assert.equal((await call(boot.token, "recovery.ladder.set", { levels: [] }, "r1")).error?.code, "command_conflict");
    assert.equal((await call(boot.token, "recovery.ladder.disable", { expectedRevision: 0 }, "r2")).error?.code, "stale_revision");
    assert.ok((await call(boot.token, "recovery.ladder.disable", { expectedRevision: set.result.revision }, "r3")).ok);
    const off = (await call(boot.token, "recovery.ladder.get", {})).result.item;
    assert.deepEqual([off.enabled, off.levels], [false, got.levels], "disabling keeps the levels");
    assert.ok((await call(boot.token, "recovery.ladder.enable", {}, "r4")).ok);
    assert.equal((await call(boot.token, "recovery.ladder.get", {})).result.item.enabled, true);
    assert.ok((await call(boot.token, "recovery.ladder.set", { levels: [] }, "r5")).ok);
    const cleared = (await call(boot.token, "recovery.ladder.get", {})).result.item;
    assert.deepEqual([cleared.levels, cleared.owner], [[], ["stop"]], "an empty list clears the levels and leaves the other fields");
    assert.equal(CHAT_OPS["recovery.ladder.set"]?.mode, "propose");
    assert.equal(CHAT_OPS["recovery.ladder.enable"]?.mode, "propose", "widening is shown first");
    assert.ok(CHAT_OPS["recovery.ladder.disable"], "chat can switch it off");
  } finally {
    await c.close();
    rmSync(d, { recursive: true, force: true });
  }
});
