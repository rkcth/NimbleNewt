import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { SqliteStorage } from "../storage/index.js";
import { BackupService, MaintenanceBarrier, StagedRestore, applyPendingRestore, createKeyring, secretsSourceOf, unlockWithPasscode } from "./index.js";

const AT = "2026-11-12T10:00:00.000Z";
const PASS = "correct horse battery staple 42";
const FAST = { N: 2 ** 16, r: 8, p: 1 } as const;

async function rig(scope: "secrets" | "everything", withUnlock: boolean) {
  const d = mkdtempSync(join(tmpdir(), "nn-k01bs-"));
  const data = join(d, "data"); mkdirSync(data);
  const sqlite = join(data, "c.sqlite");
  const { keyring } = await createKeyring({ passcode: PASS, scrypt: FAST });
  const storage = await SqliteStorage.open({ path: sqlite });
  const { epoch } = await storage.acquireEpoch({ holder: "c1", at: AT });
  await storage.applyOperation({ operationId: "op-1", epoch, actor: "owner:rob", correlationId: "co-1", at: AT, changes: [{ type: "create", ref: { kind: "task", id: "task-a" }, body: { title: "t" } }], audit: [{ type: "task.created", detail: {} }], outbox: [], effects: [], timers: [], cancelTimers: [], completeDeliveries: [], completeTimers: [], settleEffects: [] } as never);
  const live = new Map([["a.key", "backup-time-value"], ["b.key", "other"]]);
  const store = { get: async (n: string) => live.get(n), resolve: async (n: string) => live.get(n), set: async (n: string, v: string) => { live.set(n, v); } };
  const backups = new BackupService(storage, { root: join(d, "b"), version: "t", now: () => new Date(AT), encryptionSource: async () => ({ keyring, scope }), secrets: secretsSourceOf(store, () => ["a.key", "b.key"]) });
  const made = await backups.backUpNow("manual");
  live.set("a.key", "rotated-since"); live.delete("b.key"); // a.key changed after the backup, b.key lost
  const sr = new StagedRestore({ backups, root: join(d, "b"), barrier: new MaintenanceBarrier(), sqlitePath: sqlite, dataDirectory: data, storage, ...(withUnlock ? { unlock: async () => unlockWithPasscode(keyring, PASS) } : {}), secrets: store, now: () => new Date("2026-11-12T11:00:00.000Z") });
  return { d, data, sqlite, storage, made, sr, live };
}

for (const scope of ["secrets", "everything"] as const) {
  test(`restoring from inside the controller, scope ${scope}: lost secrets come back, a secret changed since is kept, and the answer carries counts only (card K01b)`, async () => {
    const r = await rig(scope, true);
    try {
      const plan = await r.sr.preview(r.made.manifest.name);
      assert.equal(plan.encrypted, true);
      const done = await r.sr.apply(plan.name, plan.token);
      assert.deepEqual(done.result.secrets, { restored: 1, same: 0, keptDifferent: 1, overwritten: 0 });
      assert.equal(r.live.get("b.key"), "other");
      assert.equal(r.live.get("a.key"), "rotated-since", "not rolled back");
      assert.equal(JSON.stringify(done).includes("backup-time-value"), false);
      await r.storage.close();
      assert.equal(await applyPendingRestore(r.data, r.sqlite, undefined, {}), r.made.manifest.name);
    } finally { await r.storage.close().catch(() => undefined); rmSync(r.d, { recursive: true, force: true }); }
  });
}

test("restoring a 'secrets only' backup on a host with no unlock method still restores everything else and says the secret values were left out; scope everything refuses (card K01b)", async () => {
  const r = await rig("secrets", false);
  try {
    const plan = await r.sr.preview(r.made.manifest.name);
    assert.match(plan.warnings.join(" "), /Only the secret values in this backup are sealed/);
    const done = await r.sr.apply(plan.name, plan.token);
    assert.match(done.result.secretsLeftOut ?? "", /no passcode or recovery file/);
    assert.equal(done.result.secrets, undefined);
    assert.equal(r.live.get("a.key"), "rotated-since");
  } finally { await r.storage.close().catch(() => undefined); rmSync(r.d, { recursive: true, force: true }); }
  const e = await rig("everything", false);
  try {
    const plan = await e.sr.preview(e.made.manifest.name);
    await assert.rejects(e.sr.apply(plan.name, plan.token), /no unlock method is set up/);
  } finally { await e.storage.close().catch(() => undefined); rmSync(e.d, { recursive: true, force: true }); }
});
