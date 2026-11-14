import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { backends, stopServer } from "../domain/testing/backends.js";
import type { ControllerStorage, OperationInput } from "../storage/types.js";
import { BackupService, MaintenanceBarrier, StagedRestore, externalSince } from "./index.js";

after(stopServer);
const BACKUP_AT = "2026-11-01T10:00:00.000Z";
const BEFORE = "2026-11-01T09:00:00.000Z";
const AFTER = "2026-11-01T12:00:00.000Z";
const DIGEST = "a".repeat(64);
const op = (operationId: string, epoch: number, at: string, over: Partial<OperationInput>): OperationInput => ({ operationId, epoch, actor: "owner:rob", correlationId: `c-${operationId}`, at, changes: [], audit: [], outbox: [], effects: [], timers: [], cancelTimers: [], completeDeliveries: [], completeTimers: [], settleEffects: [], ...over });

/**
 * Card K03, "restore distinguishes external effects since snapshot": a restore puts the data back, not the world. What was done outside NimbleNewt after the backup (an effect finished, a message delivered) is counted from
 * the live data and named in the preview, apart from what the backup itself holds as only intended.
 */
for (const backend of backends) {
  test(`${backend.name}: the restore preview says what happened outside after the backup was made, and what the backup only intended`, async () => {
    const world = await backend.open();
    const dir = mkdtempSync(join(tmpdir(), "nn-k03e-"));
    try {
      const s: ControllerStorage = world.storage;
      const { epoch } = await s.acquireEpoch({ holder: "c1", at: BEFORE });
      // Before the backup: one effect already confirmed (a push), one only intended, one delivery waiting and one already delivered.
      await s.applyOperation(op("o1", epoch, BEFORE, {
        changes: [{ type: "create", ref: { kind: "task", id: "t1" }, body: { n: 1 } }],
        effects: [{ effectId: "e-old", target: "repo:main", inputDigest: DIGEST }, { effectId: "e-intended", target: "repo:release", inputDigest: DIGEST }],
        outbox: [{ deliveryId: "d-waiting", destination: "chat", priority: 5, payload: { text: "waiting" }, aggregate: { kind: "task", id: "t1" } } as never, { deliveryId: "d-old", destination: "chat", priority: 5, payload: { text: "old" }, aggregate: { kind: "task", id: "t1" } } as never],
      }));
      await s.applyOperation(op("o2", epoch, BEFORE, { settleEffects: [{ effectId: "e-old", outcome: "confirmed" }] }));
      const backups = new BackupService(s, { root: join(dir, "b"), version: "t", now: () => new Date(BACKUP_AT) });
      const made = await backups.backUpNow("manual");
      // After the backup: the intended effect finishes, a new effect finishes, another fails, one is left uncertain, and the waiting message is delivered.
      const claimed = await s.claimDeliveries({ epoch, destination: "chat", claimant: "w", now: AFTER, leaseMs: 60_000, limit: 5 });
      const waiting = claimed.find((c) => c.deliveryId === "d-waiting");
      assert.ok(waiting !== undefined, "the waiting message was claimed");
      await s.applyOperation(op("o3", epoch, AFTER, {
        effects: [{ effectId: "e-new", target: "mail:owner", inputDigest: DIGEST }, { effectId: "e-failed", target: "repo:other", inputDigest: DIGEST }, { effectId: "e-unsure", target: "pay:invoice-7", inputDigest: DIGEST }],
        completeDeliveries: [{ deliveryId: "d-waiting", claimToken: waiting!.claimToken, receipt: { ok: true } }],
        settleEffects: [{ effectId: "e-intended", outcome: "confirmed" }],
      }));
      await s.applyOperation(op("o4", epoch, AFTER, { settleEffects: [{ effectId: "e-new", outcome: "confirmed" }, { effectId: "e-failed", outcome: "failed" }, { effectId: "e-unsure", outcome: "uncertain" }] }));

      const data = join(dir, "data"); mkdirSync(data);
      const sr = new StagedRestore({ backups, root: join(dir, "b"), barrier: new MaintenanceBarrier(), sqlitePath: join(data, "x.sqlite"), dataDirectory: data, storage: s, now: () => new Date(AFTER) });
      const plan = await sr.preview(made.manifest.name);
      const since = plan.externalSinceBackup!;
      assert.deepEqual([since.happened, since.unknown, since.failed, since.deliveredAfter], [2, 1, 1, 1], JSON.stringify(since));
      assert.deepEqual(since.targets, ["mail:owner", "pay:invoice-7", "repo:release"], "what was touched, not the effect that failed and not the one confirmed before the backup");
      assert.equal(since.truncated, false);
      assert.equal(plan.effectsToMarkUncertain, 1, "what the backup itself holds as intended is a separate figure");
      const text = plan.warnings.join("\n");
      assert.match(text, /Since this backup was made, 2 actions outside NimbleNewt finished, 1 more is not known to have finished or not, 1 message was delivered/);
      assert.match(text, /cannot undo any of that.*check mail:owner, pay:invoice-7, repo:release before anything is repeated/);
    } finally { await world.close(); rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }); }
  });
}

test("a preview with nothing outside since the backup says nothing about it, and a store that cannot be read gives no figure (K03)", async () => {
  const empty = { read: async () => [] as Record<string, string | number | null>[] };
  assert.deepEqual(await externalSince(empty, BACKUP_AT), { happened: 0, unknown: 0, failed: 0, deliveredAfter: 0, targets: [], truncated: false });
  assert.equal(await externalSince({ read: async () => { throw new Error("gone"); } }, BACKUP_AT), undefined);
  assert.equal(await externalSince(empty, "not a time"), undefined);
  // a store larger than the scan is a lower bound, said so
  const endless = { read: async () => Array.from({ length: 500 }, (_, i) => ({ effect_id: `e${i}`, status: "confirmed", target: `t${i % 3}`, created_at: AFTER, updated_at: AFTER })) as Record<string, string | number | null>[] };
  const big = await externalSince(endless, BACKUP_AT);
  assert.equal(big!.truncated, true);
  assert.ok(big!.happened >= 500);
  assert.equal(big!.targets.length, 3);
});
