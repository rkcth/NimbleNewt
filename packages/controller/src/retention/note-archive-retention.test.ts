import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { after, test } from "node:test";
import { BlockerService, DomainError, ProjectService } from "../domain/index.js";
import { backends, stopServer } from "../domain/testing/backends.js";
import { ContextEnforcementService, DeskService, HistoryService, RetrievalService } from "../context/index.js";
import { PrincipalService, type Principal } from "../security/index.js";
import type { ControllerStorage } from "../storage/types.js";
import { RETENTION_DEFAULTS, RetentionService } from "./index.js";

after(stopServer);

const DAY = 86_400_000;
const dig = (s: string): string => `sha256:${createHash("sha256").update(s).digest("hex")}`;
let n = 0;
const cid = (label: string): string => `${label}-${n++}`;
const on = { ...RETENTION_DEFAULTS, reserveBytes: 0, noteArchiveDays: 30 as number | null };

// Card K06c (context archives): the whole text of a cut note is removed by an owner-set rule once its task is finished, and a write of the same note afterwards is not lost.
for (const backend of backends) {
  test(`${backend.name}: note archives of finished tasks are removed on the owner's days only, previewed, digest-confirmed, revision-guarded and audited; a removed archive written again is a real record again (card K06c)`, async () => {
    const world = await backend.open();
    try {
      const storage: ControllerStorage = world.storage;
      // The test's own clock: archives are written 40 days before "now" (old) or at "now" (young).
      const real = Date.now();
      const box = { at: real - 40 * DAY };
      const options = { clock: () => new Date(box.at).toISOString(), pause: async () => undefined };
      const projects = await ProjectService.open(storage, { holder: "c1", ...options });
      const epoch = projects.epoch;
      const principals = PrincipalService.withEpoch(storage, epoch, options);
      const owner: Principal = await principals.authenticate((await principals.bootstrapOwner({ name: "rob" })).token);
      const project = (await projects.createProject({ commandId: cid("p"), actor: owner.id, name: "A" })).id;
      const mk = async (title: string): Promise<string> => (await projects.createTask({ commandId: cid("t"), actor: owner.id, projectId: project, title })).id;
      const finish = async (task: string, to: "done" | "cancelled"): Promise<void> => {
        const path = to === "done" ? ["ready", "in_progress", "done"] : ["cancelled"];
        for (const step of path) await projects.transitionTask({ commandId: cid("mv"), actor: owner.id, taskId: task, expectedRevision: (await projects.getTask(task))!.revision, to: step as never });
      };
      const done = await mk("finished"); const cancelled = await mk("dropped"); const live = await mk("running"); const blocked = await mk("waiting");
      await finish(done, "done"); await finish(cancelled, "cancelled");
      await projects.transitionTask({ commandId: cid("mv"), actor: owner.id, taskId: blocked, expectedRevision: 1, to: "ready" });
      const desks = DeskService.withEpoch(storage, epoch, options);
      const histories = HistoryService.withEpoch(storage, epoch, options);
      const retrieval = RetrievalService.withEpoch(storage, epoch, desks, histories, options);
      const blockers = BlockerService.withEpoch(storage, epoch, options);
      const enf = ContextEnforcementService.withEpoch(storage, epoch, { blockers, retrieval }, options);
      const keep = async (task: string, text: string): Promise<{ id: string; replayed: boolean }> => enf.archiveNote(owner, { taskId: task, what: "a hand-off note", digest: dig(text), text });
      const has = async (id: string) => (await storage.getAggregate({ kind: "ctx-note-archive", id })) !== undefined;
      const SECRET = "the whole secret words of the cut note";

      const aDone = await keep(done, `${SECRET} one`); const aCancelled = await keep(cancelled, `${SECRET} two`);
      const aLive = await keep(live, `${SECRET} three`); const aBlocked = await keep(blocked, `${SECRET} four`);
      box.at = real; const aYoung = await keep(done, `${SECRET} young`);   // a finished task, but written today
      const svc = (v = on, extra: object = {}) => RetentionService.withEpoch(storage, epoch, { settings: { effective: async () => v }, now: () => real, ...extra } as never, { clock: () => new Date(real).toISOString(), pause: async () => undefined });

      // Off by default: nothing is a candidate however old.
      assert.deepEqual((await svc({ ...RETENTION_DEFAULTS, reserveBytes: 0 }).run(owner, {})).candidates, [], "off by default");
      const status = await svc().status(owner);
      assert.equal((status.growth as Record<string, unknown>)["ctx-note-archive"], 5, "the owner sees how many archives are stored");

      // Preview names exactly the old archives of finished tasks (done, cancelled), not a task that can still run and not a young archive, and removes nothing.
      const preview = await svc().run(owner, {});
      assert.deepEqual(preview.candidates.map((c) => c.id).sort(), [aDone.id, aCancelled.id].sort());
      for (const c of preview.candidates) { assert.equal(c.kind, "ctx-note-archive"); assert.ok(c.ageDays >= 39); assert.equal(c.projectId, project); }
      for (const id of [aDone.id, aCancelled.id, aLive.id, aBlocked.id, aYoung.id]) assert.equal(await has(id), true, "a preview removes nothing");
      await assert.rejects(svc().run(owner, { dryRun: false }), /confirm/i);
      await assert.rejects(svc().run(owner, { dryRun: false, confirm: "wrong" }), /confirm|preview|digest/i);

      // A task that was running when previewed and finished meanwhile is a different set: the digest no longer fits.
      await finish(live, "cancelled");
      await assert.rejects(svc().run(owner, { dryRun: false, confirm: preview.digest! }), /confirm|preview|digest/i);
      const p2 = await svc().run(owner, {});
      assert.deepEqual(p2.candidates.map((c) => c.id).sort(), [aDone.id, aCancelled.id, aLive.id].sort(), "once its task is cancelled the archive is a candidate");

      // The revision guard: the archive is replaced (removed and written again) between the preview and its removal. That is a different record now; the stale removal is skipped, and the new one stays.
      let replaced = false;
      const guarded = svc(on, { beforeBatch: async () => {
        if (replaced) return; replaced = true;
        const a = (await storage.getAggregate({ kind: "ctx-note-archive", id: aLive.id }))!;
        await storage.applyOperation({ operationId: cid("drop"), epoch, actor: "test", correlationId: "drop", at: new Date(real).toISOString(), changes: [{ type: "delete", ref: { kind: "ctx-note-archive", id: a.id }, expectedRevision: a.revision }], audit: [{ type: "test.drop", subject: { kind: "ctx-note-archive", id: a.id }, detail: {} }], outbox: [], effects: [], timers: [], cancelTimers: [], completeDeliveries: [], completeTimers: [], settleEffects: [] } as never);
        await keep(live, `${SECRET} three`);
      } });
      const realRun = await guarded.run(owner, { dryRun: false, confirm: p2.digest! });
      assert.equal(realRun.removed, 2, "the replaced archive is skipped by the revision guard, the other two are removed");
      assert.equal(await has(aDone.id), false); assert.equal(await has(aCancelled.id), false);
      assert.equal(await has(aLive.id), true, "the archive written again after the preview is not the one previewed");
      assert.equal((await storage.getAggregate({ kind: "ctx-note-archive", id: aLive.id }))!.revision > 1, true, "and its revision continues the removed one");
      for (const id of [aBlocked.id, aYoung.id]) assert.equal(await has(id), true, "a task that can still run, and a young archive, stay");

      // Removed, then written again: the record is really there, with its text, and the same note is removable again as a new removal.
      assert.equal(await enf.noteArchive(owner, { taskId: done, digest: dig(`${SECRET} one`) }), undefined, "a removed archive reads as one that is not kept");
      const again = await keep(done, `${SECRET} one`);
      assert.equal(again.id, aDone.id);
      assert.equal(again.replayed, false, "it was written, not answered as an earlier command");
      assert.equal((await enf.noteArchive(owner, { taskId: done, digest: dig(`${SECRET} one`) }))!.text, `${SECRET} one`, "the marker's promise is kept again");
      assert.equal(await has(aDone.id), true);
      assert.equal((await keep(done, `${SECRET} one`)).replayed, true, "a repeat while it is there writes nothing");
      // The record was written again today, so it is young; run the service 40 days ahead to age it.
      const later = RetentionService.withEpoch(storage, epoch, { settings: { effective: async () => on }, now: () => real + 40 * DAY }, { clock: () => new Date(real + 40 * DAY).toISOString(), pause: async () => undefined });
      const p4 = await later.run(owner, {});
      assert.ok(p4.candidates.some((c) => c.id === aDone.id && c.kind === "ctx-note-archive"));
      const r4 = await later.run(owner, { dryRun: false, confirm: p4.digest! });
      assert.ok(r4.removed >= 1);
      assert.equal(await has(aDone.id), false, "removed a second time (a new removal, not the first answered again)");
      const third = await keep(done, `${SECRET} one`);
      assert.equal(third.replayed, false); assert.equal(await has(aDone.id), true, "and written a third time");

      // The audit names the rule, ID, project and age; never the text.
      const rules = new Set<string>(); let after = 0;
      for (;;) {
        const page = await storage.listAudit({ afterSeq: after, limit: 500 });
        for (const e of page) { after = e.seq; if (e.type === "retention.expire") { rules.add((e.detail as { rule: string }).rule); assert.doesNotMatch(JSON.stringify(e), /secret words/); } }
        if (page.length < 500) break;
      }
      assert.deepEqual([...rules], ["note-archive-days"]);
    } finally { await world.close(); }
  });
}

test("the day range for the note archive rule is 7 to 3650 and it is off unless set (card K06c)", async () => {
  const { RETENTION_FIELDS } = await import("./settings.js");
  assert.deepEqual(RETENTION_FIELDS.noteArchiveDays, { kind: "days", min: 7, max: 3650, nullable: true });
  assert.equal(RETENTION_DEFAULTS.noteArchiveDays, null);
  void DomainError;
});
