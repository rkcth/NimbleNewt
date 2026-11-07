import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { after, test } from "node:test";
import { backends, stopServer } from "../domain/testing/backends.js";
import type { Principal } from "../security/principals.js";
import type { OperationInput } from "../storage/types.js";
import { RETENTION_DEFAULTS } from "./settings.js";
import { RetentionService, type CatalogRetentionPort } from "./service.js";

after(stopServer);

const AT = "2026-10-30T10:00:00.000Z";
const owner = { kind: "owner", id: "owner:rob" } as unknown as Principal;
let n = 0;
const op = (epoch: number, changes: OperationInput["changes"]): OperationInput => ({ operationId: `blank-${++n}`, epoch, actor: "a", correlationId: `c-${n}`, at: AT, changes, audit: [{ type: "seed", detail: {} }], outbox: [], effects: [], timers: [], cancelTimers: [], completeDeliveries: [], completeTimers: [], settleEffects: [] });

for (const backend of backends) {
  test(`${backend.name}: a task that records a revoked version's executable record as a dependency after retention read the citations, before it blanks the record, keeps the record (card T02c review)`, async () => {
    const world = await backend.open();
    try {
      const { epoch } = await world.storage.acquireEpoch({ holder: "t", at: AT });
      const text = "code to ship";
      const digest = createHash("sha256").update(text).digest("hex");
      await world.storage.applyOperation(op(epoch, [
        { type: "create", ref: { kind: "desk-record", id: "dsk-code" }, body: { title: "code", body: text, visibility: "shared", status: "accepted" } as never },
        { type: "create", ref: { kind: "task", id: "task-live" }, body: { projectId: "proj-a", state: "in_progress" } as never },
      ] as never));
      const rec = (await world.storage.getAggregate({ kind: "desk-record", id: "dsk-code" }))!;
      const catalog: CatalogRetentionPort = {
        retentionCandidates: async () => ({ items: [], partial: false }),
        revokedExecutables: async () => ({ items: [{ name: "toolbox.check", version: "1.0.0", versionId: "cav-x", recordId: "dsk-code", ageDays: 100, digest, revision: rec.revision }], partial: false }),
        dropVersion: async () => ({ dropped: false }),
      };
      let injected = 0;
      const svc = RetentionService.withEpoch(world.storage, epoch, {
        catalog, settings: { effective: async () => ({ ...RETENTION_DEFAULTS, revokedBytesDays: 1, revokedBytesBlank: true }) },
        // The gap between reading the citations and the guarded write: the task takes the record. This does not change the record's revision.
        beforeBlank: async () => { injected += 1; await world.storage.applyOperation(op(epoch, [{ type: "create", ref: { kind: "dependency-manifest", id: "dpm-1" }, body: { taskId: "task-live", entries: [{ kind: "record", key: "dsk-code" }] } as never }] as never)); },
      }, { clock: () => AT, pause: async () => undefined });
      const preview = await svc.run(owner, {});
      assert.deepEqual(preview.revokedBytes?.candidates.map((c) => c.version), ["1.0.0"], "nothing cited it at the preview");
      const done = await svc.run(owner, { dryRun: false, confirm: preview.digest! });
      assert.equal(injected, 1);
      assert.equal(done.revokedBytes?.blanked, 0);
      const after = (await world.storage.getAggregate({ kind: "desk-record", id: "dsk-code" }))!;
      assert.equal((after.body as unknown as { body: string }).body, text, "the record the task took keeps its text");
      assert.equal(after.revision, rec.revision);
    } finally { await world.close(); }
  });
}
