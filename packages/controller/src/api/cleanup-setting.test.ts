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

test("the owner sets the scratch cleanup: after-handoff by default, owner only, validated, race-safe, replay-safe, enable/disable/unset, chat can propose it", async () => {
  const d = mkdtempSync(join(tmpdir(), "nn-clean-"));
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
    const get = async () => (await call(boot.token, "cleanup.settings.get", {})).result.item;

    const first = await get();
    assert.deepEqual([first.revision, first.scratch, first.default, first.effective], [0, null, "after-handoff", { scratch: "after-handoff", awaitStopHours: 24 }]);
    assert.equal((await call(ann, "cleanup.settings.get", {})).error?.code, "forbidden");
    assert.equal((await call(ann, "cleanup.settings.change", { disable: ["scratch"] }, "c0")).error?.code, "forbidden");
    for (const [i, args] of ([{}, { set: { scratch: "delete" } }, { set: { other: "keep" } }, { set: "keep" }, { enable: ["nope"] }, { disable: "scratch" }, { set: { scratch: "keep" }, enable: ["scratch"] }, { enable: ["scratch"], disable: ["scratch"] }, { extra: 1, disable: ["scratch"] }, { disable: ["scratch"], expectedRevision: -1 }] as Record<string, unknown>[]).entries()) {
      assert.equal((await call(boot.token, "cleanup.settings.change", args, `cb${i}`)).error?.code, "invalid_command", JSON.stringify(args));
    }
    assert.equal((await get()).revision, 0, "refused changes change nothing");

    const off = await call(boot.token, "cleanup.settings.change", { disable: ["scratch"] }, "c1");
    assert.ok(off.ok, JSON.stringify(off));
    assert.deepEqual([(await get()).scratch, (await get()).effective], ["keep", { scratch: "keep", awaitStopHours: 24 }]);
    assert.equal((await call(boot.token, "cleanup.settings.change", { disable: ["scratch"] }, "c1")).result.revision, off.result.revision, "same command ID is the same change");
    assert.equal((await call(boot.token, "cleanup.settings.change", { enable: ["scratch"], expectedRevision: 0 }, "c2")).error?.code, "stale_revision");
    assert.ok((await call(boot.token, "cleanup.settings.change", { enable: ["scratch"], expectedRevision: off.result.revision }, "c3")).ok);
    assert.equal((await get()).effective.scratch, "after-handoff");
    assert.ok((await call(boot.token, "cleanup.settings.change", { set: { scratch: "keep" } }, "c4")).ok);
    assert.equal((await get()).effective.scratch, "keep");
    assert.ok((await call(boot.token, "cleanup.settings.change", { unset: ["scratch"] }, "c5")).ok);
    const back = await get();
    assert.deepEqual([back.scratch, back.effective.scratch], [null, "after-handoff"], "unset: the default applies again");
    // The patience before somebody is told that scratch is kept because a worker never confirmed stopping: chat-settable, can be off, and a change to one setting keeps the other.
    assert.ok((await call(boot.token, "cleanup.settings.change", { set: { scratch: "keep", awaitStopHours: 48 } }, "c6")).ok);
    assert.deepEqual([(await get()).scratch, (await get()).awaitStopHours, (await get()).effective.awaitStopHours], ["keep", 48, 48]);
    assert.ok((await call(boot.token, "cleanup.settings.change", { disable: ["awaitStopHours"] }, "c7")).ok);
    assert.deepEqual([(await get()).scratch, (await get()).effective.awaitStopHours], ["keep", null], "off; the scratch entry is kept");
    assert.ok((await call(boot.token, "cleanup.settings.change", { unset: ["awaitStopHours"] }, "c8")).ok);
    assert.equal((await get()).effective.awaitStopHours, 24);
    for (const [i, args] of ([{ set: { awaitStopHours: 0 } }, { set: { awaitStopHours: 1.5 } }, { set: { awaitStopHours: "soon" } }, { set: { awaitStopHours: 5 }, disable: ["awaitStopHours"] }] as Record<string, unknown>[]).entries()) {
      assert.equal((await call(boot.token, "cleanup.settings.change", args, `cw${i}`)).error?.code, "invalid_command", JSON.stringify(args));
    }
    assert.ok("cleanup.settings.change" in CHAT_OPS, "the chat can propose it");
    assert.equal(CHAT_OPS["cleanup.settings.change"]!.mode, "propose");
  } finally {
    await c.close();
    rmSync(d, { recursive: true, force: true });
  }
});
