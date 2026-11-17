import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { after, test } from "node:test";
import { DeskService } from "../context/index.js";
import { ProjectService } from "../domain/index.js";
import { backends, stopServer } from "../domain/testing/backends.js";
import { PrincipalService, type Principal } from "../security/index.js";
import type { ControllerStorage, OperationInput } from "../storage/types.js";
import { RETENTION_DEFAULTS, RetentionService, describeRun, type CatalogRetentionPort } from "./index.js";

after(stopServer);

// Card K06b follow-up T5b (second review): a hold read that fails inside a real run's scratch purge or revoked-text blanking keeps the record, and the run is reported as partial,
// so the owner's sentence does not read as a complete check.
const DAY = 86_400_000;
const AT = "2026-10-30T10:00:00.000Z";
let n = 0;
const cid = (label: string): string => `${label}-t5b2-${n++}`;
const off = { ...RETENTION_DEFAULTS, reserveBytes: 0, thinkingAuto: false };
const op = (epoch: number, changes: OperationInput["changes"]): OperationInput => ({ operationId: cid("op"), epoch, actor: "a", correlationId: cid("c"), at: AT, changes, audit: [{ type: "seed", detail: {} }], outbox: [], effects: [], timers: [], cancelTimers: [], completeDeliveries: [], completeTimers: [], settleEffects: [] } as never);

/** The same store, except that reads of decision-link records fail while `failing(count)` is true; `count` is the number of such reads so far (each read is one page here: there are fewer than 500 records). */
function linkFaults(inner: ControllerStorage): { storage: ControllerStorage; set: (f: ((count: number) => boolean) | undefined) => void; failed: () => number } {
  let reads = 0; let failed = 0; let failing: ((count: number) => boolean) | undefined;
  const storage = new Proxy(inner, {
    get(target, key) {
      if (key === "listAggregates") return async (kind: string, page: { afterId?: string; limit: number }) => {
        if (kind === "decision-reliance") { reads += 1; if (failing?.(reads) === true) { failed += 1; throw new Error("the storage could not be read"); } }
        return target.listAggregates(kind, page);
      };
      const v = Reflect.get(target, key, target) as unknown;
      return typeof v === "function" ? (v as (...a: unknown[]) => unknown).bind(target) : v;
    },
  }) as ControllerStorage;
  return { storage, set: (f) => { reads = 0; failed = 0; failing = f; }, failed: () => failed };
}

for (const backend of backends) {
  test(`${backend.name}: a link read that fails inside a real scratch purge keeps the record and the run says it is partial (card K06b follow-up T5b second review)`, async () => {
    const world = await backend.open();
    try {
      const faults = linkFaults(world.storage);
      const storage = faults.storage;
      const real = Date.now();
      const options = { clock: () => new Date(real - 60 * DAY).toISOString(), pause: async () => undefined };
      const projects = await ProjectService.open(storage, { holder: "c1", ...options });
      const epoch = projects.epoch;
      const principals = PrincipalService.withEpoch(storage, epoch, options);
      const owner: Principal = await principals.authenticate((await principals.bootstrapOwner({ name: "rob" })).token);
      const project = (await projects.createProject({ commandId: cid("p"), actor: owner.id, name: "A" })).id;
      const task = (await projects.createTask({ commandId: cid("t"), actor: owner.id, projectId: project, title: "T" })).id;
      await principals.enroll(owner, { commandId: cid("e"), kind: "agent", name: "ann", grants: [{ action: "desk.write", project }, { action: "desk.read", project }, { action: "attempt.work", project }] });
      const ann = await principals.authenticate((await principals.issueCredential(owner, "agent:ann")).token);
      const desks = DeskService.withEpoch(storage, epoch, options);
      const plan = (await desks.write(ann, { commandId: cid("w"), projectId: project, taskId: task, kind: "plan", title: "work", body: "plan to purge 9911", visibility: "private", status: "accepted" } as never)).id;
      for (const to of ["ready", "in_progress", "done"]) await projects.transitionTask({ commandId: cid("mv"), actor: owner.id, taskId: task, expectedRevision: (await projects.getTask(task))!.revision, to: to as never });
      const at = (days: number) => RetentionService.withEpoch(storage, epoch, { settings: { effective: async () => ({ ...off, scratchArchiveDays: 30, scratchPurgeDays: 30 }) }, now: () => real + days * DAY } as never, { clock: () => new Date(real + days * DAY).toISOString(), pause: async () => undefined });
      const archive = await at(0).run(owner, {});
      assert.equal((await at(0).run(owner, { dryRun: false, confirm: archive.digest! })).removed, 1);
      const preview = await at(80).run(owner, {});
      assert.deepEqual([preview.partial, preview.candidates.map((c) => [c.kind, c.id])], [false, [["scratch-purge", plan]]]);

      // A real run reads the links for its own plan (1) and before the batch (2); the deletion's own hold check (3 onward) fails.
      faults.set((count) => count >= 3);
      const ran = await at(80).run(owner, { dryRun: false, confirm: preview.digest! });
      assert.ok(faults.failed() > 0, "the deletion's own hold check failed");
      faults.set(undefined);
      assert.equal(ran.removed, 0, "the plan is not removed");
      assert.equal(ran.partial, true, "a hold that could not be read inside the purge is reported");
      assert.match(describeRun(ran), /^Retention ran: 0 expired.*Not everything could be checked.*nothing unchecked was removed\.$/);
      const body = (await world.storage.getAggregate({ kind: "desk-record", id: plan }))!.body as { deleted?: unknown; archived?: unknown };
      assert.equal(body.deleted, undefined);
      assert.notEqual(body.archived, undefined, "it stays archived, restorable");

      // With the store read normally, the same purge removes it and the run is not partial.
      const again = await at(80).run(owner, {});
      const done = await at(80).run(owner, { dryRun: false, confirm: again.digest! });
      assert.deepEqual([done.removed, done.partial], [1, false]);
    } finally { await world.close(); }
  });

  test(`${backend.name}: a link read that fails inside a real blanking of a revoked tool's text keeps the text and the run says it is partial (card K06b follow-up T5b second review)`, async () => {
    const world = await backend.open();
    try {
      const faults = linkFaults(world.storage);
      const { epoch } = await world.storage.acquireEpoch({ holder: "t", at: AT });
      const text = "code to ship 9912";
      const digest = createHash("sha256").update(text).digest("hex");
      await world.storage.applyOperation(op(epoch, [{ type: "create", ref: { kind: "desk-record", id: "dsk-code" }, body: { title: "code", body: text, visibility: "shared", status: "accepted" } as never }] as never));
      const rec = (await world.storage.getAggregate({ kind: "desk-record", id: "dsk-code" }))!;
      const catalog: CatalogRetentionPort = {
        retentionCandidates: async () => ({ items: [], partial: false }),
        revokedExecutables: async () => ({ items: [{ name: "toolbox.check", version: "1.0.0", versionId: "cav-x", recordId: "dsk-code", ageDays: 100, digest, revision: rec.revision }], partial: false }),
        dropVersion: async () => ({ dropped: false }),
      };
      const owner = { kind: "owner", id: "owner:rob" } as unknown as Principal;
      let breakNow = false; let armed = true;
      faults.set(() => breakNow);
      const svc = RetentionService.withEpoch(faults.storage, epoch, {
        catalog, settings: { effective: async () => ({ ...RETENTION_DEFAULTS, revokedBytesDays: 1, revokedBytesBlank: true }) },
        // After the run's own read of the links and before the guarded write: the read inside the write fails.
        beforeBlank: async () => { if (armed) breakNow = true; },
      } as never, { clock: () => AT, pause: async () => undefined });
      const preview = await svc.run(owner, {});
      assert.deepEqual([preview.partial, preview.revokedBytes?.candidates.map((c) => c.version)], [false, ["1.0.0"]]);
      const ran = await svc.run(owner, { dryRun: false, confirm: preview.digest! });
      assert.ok(faults.failed() > 0, "the read inside the blanking failed");
      breakNow = false; armed = false;
      assert.equal(ran.revokedBytes?.blanked, 0);
      assert.equal(ran.partial, true, "a hold that could not be read inside the blanking is reported");
      assert.match(describeRun(ran), /Not everything could be checked.*nothing unchecked was removed\.$/);
      assert.equal(((await world.storage.getAggregate({ kind: "desk-record", id: "dsk-code" }))!.body as { body: string }).body, text, "the text is kept");
      // Read normally, the same text is blanked and the run is complete.
      const again = await svc.run(owner, {});
      const done = await svc.run(owner, { dryRun: false, confirm: again.digest! });
      assert.deepEqual([done.revokedBytes?.blanked, done.partial], [1, false]);
    } finally { await world.close(); }
  });
}
