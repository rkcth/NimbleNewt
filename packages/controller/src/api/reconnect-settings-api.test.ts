import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { EnvironmentFacts, FilesystemDetector } from "../environment/index.js";
import { profileReaccept } from "../remote/reconnect-settings.js";
import { CHAT_OPS, describe, foreignValue } from "../chat/commands.js";
import { startController } from "./index.js";

const ext4: FilesystemDetector = async () => ({ type: "ext4", network: false });
const supported: EnvironmentFacts = { platform: "linux", arch: "x64", osRelease: "6.8.0-generic", nodeVersion: "22.19.0" };

test("the profile gives the reconnect default: autonomous re-accepts by itself, every other profile waits for the owner", () => {
  assert.deepEqual(["autonomous", "strict", "derived", "other"].map(profileReaccept), ["auto", "owner", "owner", "owner"]);
});

test("reconnect.settings.get/set and reconnect.reaccept through the API: owner only, validated, replay-safe, race-safe; the chat proposes both", async () => {
  const d = mkdtempSync(join(tmpdir(), "nn-rcset-"));
  const c = await startController({ storage: { kind: "sqlite", path: join(d, "c.sqlite") }, argv: [], env: {}, print: () => undefined, facts: supported, filesystem: ext4, features: [] } as never);
  try {
    const boot = await c.services.principals.bootstrapOwner({ name: "rob" });
    const rob = await c.services.principals.authenticate(boot.token);
    await c.services.principals.enroll(rob, { commandId: "e-ann", kind: "agent", name: "agt-abcdefghijklmnopqrst", grants: [] });
    const ann = (await c.services.principals.issueCredential(rob, "agent:agt-abcdefghijklmnopqrst")).token;
    const call = (token: string, op: string, args: Record<string, unknown>, commandId?: string) => c.api.handle(token, { v: 1, op, ...(commandId === undefined ? {} : { commandId }), args } as never) as Promise<{ ok: boolean; result?: any; error?: { code: string } }>;
    const g0 = (await call(boot.token, "reconnect.settings.get", {})).result.item;
    assert.deepEqual([g0.revision, g0.reaccept, g0.profile, g0.effective], [0, null, "strict", "owner"]);
    assert.equal((await call(ann, "reconnect.settings.get", {})).error?.code, "forbidden");
    assert.equal((await call(ann, "reconnect.settings.set", { reaccept: "auto" }, "r0")).error?.code, "forbidden");
    assert.equal((await call(ann, "reconnect.reaccept", { attemptId: "att-aaaaaaaaaaaaaaaaaaaa", placement: 1, sessionId: "ses-1", decision: "approve" }, "r0b")).error?.code, "forbidden");
    for (const [i, bad] of (["yes", 1, undefined, ""] as unknown[]).entries()) assert.equal((await call(boot.token, "reconnect.settings.set", { reaccept: bad }, `rb${i}`)).error?.code, "invalid_command", String(bad));
    const set = await call(boot.token, "reconnect.settings.set", { reaccept: "auto" }, "r1");
    assert.ok(set.ok, JSON.stringify(set));
    assert.equal((await call(boot.token, "reconnect.settings.set", { reaccept: "auto" }, "r1")).result.revision, set.result.revision);
    assert.equal((await call(boot.token, "reconnect.settings.set", { reaccept: "owner", expectedRevision: 0 }, "r2")).error?.code, "stale_revision");
    assert.equal((await call(boot.token, "reconnect.settings.get", {})).result.item.effective, "auto");
    assert.ok((await call(boot.token, "reconnect.settings.set", { reaccept: "owner", expectedRevision: set.result.revision }, "r3")).ok);
    assert.equal((await call(boot.token, "reconnect.settings.get", {})).result.item.effective, "owner");
    assert.ok((await call(boot.token, "reconnect.settings.set", { reaccept: null }, "r4")).ok);
    assert.equal((await call(boot.token, "reconnect.settings.get", {})).result.item.reaccept, null);
    // The patience of an attempt that waits for the owner: 24 hours unless chosen; settable, can be off, validated; the other field is kept.
    const g1 = (await call(boot.token, "reconnect.settings.get", {})).result.item;
    assert.deepEqual([g1.patienceHours, g1.patienceChosen], [24, false]);
    for (const [i, bad] of ([0, -1, "never", 24 * 366, Number.NaN] as unknown[]).entries()) assert.equal((await call(boot.token, "reconnect.settings.set", { patienceHours: bad }, `pb${i}`)).error?.code, "invalid_command", String(bad));
    assert.ok((await call(boot.token, "reconnect.settings.set", { reaccept: "auto" }, "p0")).ok);
    assert.ok((await call(boot.token, "reconnect.settings.set", { patienceHours: 6 }, "p1")).ok);
    const g2 = (await call(boot.token, "reconnect.settings.get", {})).result.item;
    assert.deepEqual([g2.patienceHours, g2.patienceChosen, g2.reaccept], [6, true, "auto"]);
    assert.ok((await call(boot.token, "reconnect.settings.set", { patienceHours: "off" }, "p2")).ok);
    assert.equal((await call(boot.token, "reconnect.settings.get", {})).result.item.patienceHours, "off");
    assert.ok((await call(boot.token, "reconnect.settings.set", { patienceHours: null }, "p3")).ok);
    const g3 = (await call(boot.token, "reconnect.settings.get", {})).result.item;
    assert.deepEqual([g3.patienceHours, g3.patienceChosen, g3.reaccept], [24, false, "auto"]);
    // The list of attempts that wait is for the owner; the chat proposes the decision with its session.
    assert.equal((await call(ann, "reconnect.pending", {})).error?.code, "forbidden");
    assert.equal((await call(boot.token, "reconnect.pending", {})).error?.code, "unavailable");
    assert.equal(CHAT_OPS["reconnect.reaccept"]!.mode, "propose");
    const line = describe("reconnect.reaccept", { attemptId: "att-aaaaaaaaaaaaaaaaaaaa", placement: 1, sessionId: "ses-7", waitingSince: "2026-10-30T10:00:00.000Z", decision: "approve" }, {});
    assert.match(line, /sessionId=ses-7/);
    assert.equal(foreignValue({ attemptId: "att-aaaaaaaaaaaaaaaaaaaa", sessionId: "ses-7", waitingSince: "2026-10-30T10:00:00.000Z", decision: "approve" }, "approve it"), undefined);
    // Without remote workers there is nothing to decide on.
    assert.equal((await call(boot.token, "reconnect.reaccept", { attemptId: "att-aaaaaaaaaaaaaaaaaaaa", placement: 1, sessionId: "ses-1", decision: "approve" }, "r5")).error?.code, "unavailable");
  } finally { await c.close(); rmSync(d, { recursive: true, force: true }); }
});
