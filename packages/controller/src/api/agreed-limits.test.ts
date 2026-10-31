import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { CHAT_OPS } from "../chat/index.js";
import { ManualTimer } from "../dispatch/testing/timer.js";
import type { EnvironmentFacts, FilesystemDetector } from "../environment/index.js";
import type { Principal } from "../security/principals.js";
import { MemoryStorage } from "../storage/memory.js";
import { DomainError } from "../domain/errors.js";
import { AgreedLimitsSettingsService } from "./agreed-limits-settings.js";
import { startController } from "./index.js";

const ext4: FilesystemDetector = async () => ({ type: "ext4", network: false });
const supported: EnvironmentFacts = { platform: "linux", arch: "x64", osRelease: "6.8.0-generic", nodeVersion: "22.19.0" };
const owner = { id: "owner:rob", kind: "owner", name: "rob", grants: [] } as unknown as Principal;

test("agreed.limits.change through the API: none by default, owner only, validated, expectedRevision, replay-safe; proposed first in chat", async () => {
  const d = mkdtempSync(join(tmpdir(), "nn-agrlim-"));
  const c = await startController({ storage: { kind: "sqlite", path: join(d, "c.sqlite") }, argv: [], env: {}, print: () => undefined, facts: supported, filesystem: ext4, features: [], dispatch: { timer: new ManualTimer(), manual: true } } as never);
  try {
    const boot = await c.services.principals.bootstrapOwner({ name: "rob" });
    const call = (token: string, op: string, args: Record<string, unknown>, commandId?: string): Promise<any> => c.api.handle(token, { v: 1, op, ...(commandId === undefined ? {} : { commandId }), args } as never) as never;
    assert.deepEqual((await call(boot.token, "agreed.limits.get", {})).result.item, { revision: 0, limits: {} }, "no ceiling by default");
    const set = await call(boot.token, "agreed.limits.change", { set: { raiseMaxCostMicros: 7_000_000_000, grantMaxDays: 90 } }, "a1");
    assert.ok(set.ok, JSON.stringify(set));
    assert.deepEqual((await call(boot.token, "agreed.limits.get", {})).result.item.limits, { raiseMaxCostMicros: 7_000_000_000, grantMaxDays: 90 });
    assert.equal((await call(boot.token, "agreed.limits.change", { set: { raiseMaxComputeMs: 1000 }, expectedRevision: 0 }, "a2")).error?.code, "stale_revision");
    for (const [i, bad] of ([{}, { set: {} }, { set: { grantMaxDays: 0 } }, { set: { grantMaxDays: 1.5 } }, { set: { raiseMaxCostMicros: -1 } }, { set: { bogus: 1 } }, { unset: ["bogus"] }, { unset: "grantMaxDays" }, { set: { grantMaxDays: 5 }, unset: ["grantMaxDays"] }, { set: { grantMaxDays: 5 }, extra: 1 }] as Record<string, unknown>[]).entries()) {
      assert.equal((await call(boot.token, "agreed.limits.change", bad, `b${i}`)).error?.code, "invalid_command", JSON.stringify(bad));
    }
    assert.deepEqual((await call(boot.token, "agreed.limits.get", {})).result.item.limits, { raiseMaxCostMicros: 7_000_000_000, grantMaxDays: 90 }, "refused changes changed nothing");
    const again = await call(boot.token, "agreed.limits.change", { set: { raiseMaxCostMicros: 7_000_000_000, grantMaxDays: 90 } }, "a1");
    assert.equal(again.result.revision, set.result.revision, "a replay changes nothing");
    assert.ok((await call(boot.token, "agreed.limits.change", { unset: ["raiseMaxCostMicros", "grantMaxDays"], expectedRevision: set.result.revision }, "a3")).ok);
    assert.deepEqual((await call(boot.token, "agreed.limits.get", {})).result.item.limits, {}, "cleared: unlimited again");
    // Only the owner: an agent, even one holding every action, may neither read nor change it.
    await c.services.principals.enroll(await c.services.principals.authenticate(boot.token), { commandId: "e-ann", kind: "agent", name: "agt-abcdefghijklmnopqrst", grants: [{ action: "*", project: "*" }] });
    const ann = (await c.services.principals.issueCredential(await c.services.principals.authenticate(boot.token), "agent:agt-abcdefghijklmnopqrst")).token;
    assert.equal((await call(ann, "agreed.limits.change", { set: { grantMaxDays: 1 } }, "a4")).error?.code, "forbidden");
    assert.equal((await call(ann, "agreed.limits.get", {})).error?.code, "forbidden");
    assert.ok(CHAT_OPS["agreed.limits.change"], "the chat can propose it");
    assert.equal(CHAT_OPS["agreed.limits.change"]!.mode, "propose");
  } finally { await c.close(); rmSync(d, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }); }
});

test("a damaged agreed-limits record or a storage fault makes effective() throw, never 'no ceiling'", async () => {
  const storage = new MemoryStorage();
  const { epoch } = await storage.acquireEpoch({ holder: "t", at: "2026-01-01T00:00:00.000Z" });
  const svc = AgreedLimitsSettingsService.withEpoch(storage, epoch);
  assert.deepEqual(await svc.effective(), {});
  await svc.change(owner, { commandId: "c1", set: { grantMaxDays: 30 } });
  assert.deepEqual(await svc.effective(), { grantMaxDays: 30 });
  const real = storage.getAggregate.bind(storage);
  for (const body of [{ limits: { grantMaxDays: 0 } }, { limits: { gpus: 3 } }, { limits: "lots" }, { limits: [1] }]) {
    storage.getAggregate = async (ref) => { const a = await real(ref); return ref.kind === "agreed-limits-settings" && a !== undefined ? { ...a, body } as never : a; };
    // A DomainError (not a plain Error), so the meeting applier fails the change visibly instead of retrying it unseen.
    await assert.rejects(svc.effective(), (e: unknown) => e instanceof DomainError && e.code === "invalid_command", JSON.stringify(body));
  }
  storage.getAggregate = async () => { throw new Error("disk gone"); };
  await assert.rejects(svc.effective(), /./);
});
