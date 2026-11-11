import assert from "node:assert/strict";
import { test } from "node:test";
import { MemoryStorage } from "../storage/index.js";
import type { Principal } from "../security/principals.js";
import { BackupEncryptionSettingService, BackupProofReminder, describeSetting, sealsBackups, type EncryptionChange } from "./index.js";

const owner = { kind: "owner", id: "owner:rob", grants: [] } as unknown as Principal;
const agent = { kind: "agent", id: "agent:zed", grants: [] } as unknown as Principal;
const scoped = { kind: "owner", id: "owner:rob", grants: [], taskScope: { taskId: "t" } } as unknown as Principal;

async function service(): Promise<BackupEncryptionSettingService> {
  const s = new MemoryStorage();
  const { epoch } = await s.acquireEpoch({ holder: "c1", at: "2026-11-01T10:00:00.000Z" });
  return BackupEncryptionSettingService.withEpoch(s, epoch);
}

test("the encryption setting is owner only at the service itself, validated, revision-checked, replay-safe and announced once per real change (card K01b3)", async () => {
  const svc = await service();
  const told: EncryptionChange[] = [];
  svc.onChanged(async (c) => { told.push(c); });
  assert.deepEqual(await svc.effective(), { enabled: true, scope: "everything" }, "no record means on, for everything");
  for (const who of [agent, scoped]) {
    await assert.rejects(svc.set(who, { commandId: "c0", enabled: false }), /may not change backup encryption/);
    await assert.rejects(svc.get(who), /may not read/);
  }
  assert.deepEqual(await svc.effective(), { enabled: true, scope: "everything" }, "a refused change changes nothing");
  assert.equal(told.length, 0);
  for (const bad of [{}, { enabled: "yes" }, { scope: "nothing" }, { enabled: false, extra: 1 }, { enabled: false, expectedRevision: -1 }, { enabled: true }]) await assert.rejects(svc.set(owner, { commandId: "cb", ...bad } as never), /./, JSON.stringify(bad));
  await assert.rejects(svc.set(owner, { commandId: "cs", enabled: false, expectedRevision: 3 }), /revision/);
  const off = await svc.set(owner, { commandId: "c1", enabled: false, expectedRevision: 0 });
  assert.deepEqual([off.enabled, off.weaker, off.changed, off.revision], [false, true, true, 1]);
  assert.equal(told.length, 1);
  assert.deepEqual([told[0]!.before.enabled, told[0]!.after.enabled, told[0]!.weaker], [true, false, true]);
  // The same command again is the same change: nothing is announced a second time.
  const replay = await svc.set(owner, { commandId: "c1", enabled: false, expectedRevision: 0 });
  assert.equal(replay.changed, false);
  assert.equal(told.length, 1);
  assert.deepEqual(await svc.effective(), { enabled: false, scope: "everything" });
  // Turning it on with a narrower scope in one go: on, secrets: not "weaker" than off, and seals nothing.
  const on = await svc.set(owner, { commandId: "c2", enabled: true, scope: "secrets" });
  assert.equal(on.weaker, false);
  assert.equal(sealsBackups(await svc.effective()), false);
  const got = await svc.get(owner);
  assert.deepEqual([got.enabled, got.scope, got.revision, got.changedBy], [true, "secrets", 2, "owner:rob"]);
});

test("what seals a backup, and the words said back to the owner (card K01b3)", () => {
  assert.equal(sealsBackups({ enabled: true, scope: "everything" }), true);
  assert.equal(sealsBackups({ enabled: false, scope: "everything" }), false);
  assert.equal(sealsBackups({ enabled: true, scope: "secrets" }), false);
  assert.match(describeSetting({ enabled: false, scope: "everything" }), /OFF.*plain.*already made stay encrypted/);
  assert.match(describeSetting({ enabled: true, scope: "secrets" }), /No secret values are in a backup today/);
});

test("the proof reminder raises once when due, escalates only after the grace days, closes when proved, and holds no secret (card K01b3)", async () => {
  const log: string[] = [];
  const open = new Set<string>();
  const notifications = {
    openRefIds: async () => [...open],
    emitFromController: async (c: { ref: { id: string }; label?: string; detail?: string; interrupt?: boolean }) => { open.add(c.ref.id); log.push(`emit ${c.ref.id}${c.interrupt === true ? " interrupt" : ""}: ${c.label} | ${c.detail}`); return { itemId: "i", coalesced: false, immediate: false }; },
    settleFromController: async (c: { ref: { id: string } }) => { open.delete(c.ref.id); log.push(`settle ${c.ref.id}`); return { closed: true }; },
  };
  let due = false; let now = Date.parse("2026-11-01T00:00:00.000Z");
  const r = new BackupProofReminder({ notifications: notifications as never, source: { due: () => due, since: () => "2026-11-01T00:00:00.000Z", everyDays: 92 }, now: () => new Date(now), everyMs: 0 });
  await r.sweep();
  assert.deepEqual(log, [], "nothing due, nothing said");
  due = true; now += 93 * 86_400_000;
  assert.deepEqual((await r.sweep()).raised, ["due"]);
  assert.deepEqual((await r.sweep()).raised, [], "once, not on every look");
  assert.equal(log.length, 1);
  assert.match(log[0]!, /^emit due: Time to check your backup passcode or recovery file \| .*backup\.encryption\.verify/);
  assert.ok(!/interrupt/.test(log[0]!), "the first reminder does not interrupt");
  now += 12 * 86_400_000;
  assert.deepEqual((await r.sweep()).raised, [], "13 days over is still inside the 14 days' grace");
  now += 2 * 86_400_000;
  assert.deepEqual((await r.sweep()).raised, ["overdue"]);
  assert.match(log.at(-1)!, /emit overdue interrupt: Urgent: backup passcode or recovery file not proved for 10[0-9] days/);
  due = false;
  assert.deepEqual((await r.sweep()).cleared.sort(), ["due", "overdue"]);
  assert.equal(open.size, 0);
  // The throttle: with an interval set, a second look inside it does nothing.
  const slow = new BackupProofReminder({ notifications: notifications as never, source: { due: () => true, since: () => undefined, everyDays: 92 }, now: () => new Date(now), everyMs: 300_000 });
  assert.deepEqual((await slow.sweep({ throttled: true })).raised, ["due"]);
  open.clear();
  assert.deepEqual((await slow.sweep({ throttled: true })).raised, []);
});
