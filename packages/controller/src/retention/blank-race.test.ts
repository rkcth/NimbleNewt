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

  test(`${backend.name}: a revoked tool's executable that is a plan a decision link names (current or superseded) is not blanked, also when the link is made in the gap before the guarded write; an unfinished link read blanks nothing (card K06b follow-up T5 review)`, async () => {
    const world = await backend.open();
    try {
      const { epoch } = await world.storage.acquireEpoch({ holder: "t", at: AT });
      const text = "plan that became a tool";
      const digest = createHash("sha256").update(text).digest("hex");
      await world.storage.applyOperation(op(epoch, [
        { type: "create", ref: { kind: "desk-record", id: "dsk-plan" }, body: { kind: "plan", title: "plan", body: text, visibility: "private", status: "accepted" } as never },
        { type: "create", ref: { kind: "desk-record", id: "dsk-old" }, body: { kind: "plan", title: "old plan", body: text, visibility: "private", status: "accepted" } as never },
        { type: "create", ref: { kind: "decision-reliance", id: "drl-old" }, body: { taskId: "task-old", links: [{ id: "lnk-old", subject: { kind: "plan", id: "dsk-old" }, decisionId: "dcs-1", state: "superseded" }] } as never },
      ] as never));
      const rec = (await world.storage.getAggregate({ kind: "desk-record", id: "dsk-plan" }))!;
      const old = (await world.storage.getAggregate({ kind: "desk-record", id: "dsk-old" }))!;
      const item = (id: string, revision: number) => ({ name: `toolbox.${id}`, version: "1.0.0", versionId: `cav-${id}`, recordId: id, ageDays: 100, digest, revision });
      const catalog: CatalogRetentionPort = {
        retentionCandidates: async () => ({ items: [], partial: false }),
        revokedExecutables: async () => ({ items: [item("dsk-plan", rec.revision), item("dsk-old", old.revision)], partial: false }),
        dropVersion: async () => ({ dropped: false }),
      };
      let breakLinks = false;
      const storage = new Proxy(world.storage, { get: (t, k) => { const v = (t as never)[k] as unknown; if (k === "listAggregates") return async (kind: string, o: never) => { if (breakLinks && kind === "decision-reliance") throw new Error("link read failed"); return t.listAggregates(kind, o); }; return typeof v === "function" ? (v as (...a: unknown[]) => unknown).bind(t) : v; } });
      let injected = 0;
      const svc = RetentionService.withEpoch(storage, epoch, {
        catalog, settings: { effective: async () => ({ ...RETENTION_DEFAULTS, revokedBytesDays: 1, revokedBytesBlank: true }) },
        // The gap between the preview and the guarded write: a decision link names the plan. This does not change the record's revision.
        beforeBlank: async (id: string) => { if (id !== "dsk-plan") return; injected += 1; await world.storage.applyOperation(op(epoch, [{ type: "create", ref: { kind: "decision-reliance", id: "drl-new" }, body: { taskId: "task-new", links: [{ id: "lnk-new", subject: { kind: "plan", id: "dsk-plan" }, decisionId: "dcs-1", state: "current" }] } as never }] as never)); },
      } as never, { clock: () => AT, pause: async () => undefined });
      breakLinks = true;
      const blind = await svc.run(owner, {});
      assert.deepEqual(blind.revokedBytes?.candidates ?? [], [], "an unfinished link read blanks nothing");
      assert.equal(blind.partial, true);
      breakLinks = false;
      const preview = await svc.run(owner, {});
      assert.deepEqual(preview.revokedBytes?.candidates.map((c) => c.name), ["toolbox.dsk-plan"], "the plan behind a superseded link is not a candidate");
      const done = await svc.run(owner, { dryRun: false, confirm: preview.digest! });
      assert.equal(injected, 1);
      assert.equal(done.revokedBytes?.blanked, 0);
      for (const [id, revision] of [["dsk-plan", rec.revision], ["dsk-old", old.revision]] as const) {
        const now = (await world.storage.getAggregate({ kind: "desk-record", id }))!;
        assert.equal((now.body as unknown as { body: string }).body, text, `${id} keeps its text`);
        assert.equal(now.revision, revision);
      }
    } finally { await world.close(); }
  });
}
