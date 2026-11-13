import assert from "node:assert/strict";
import { after, test } from "node:test";
import { ProjectService } from "../domain/index.js";
import { backends, stopServer } from "../domain/testing/backends.js";
import { PrincipalService, type Principal } from "../security/index.js";
import type { ControllerStorage } from "../storage/types.js";
import { RETENTION_DEFAULTS, RetentionService } from "./index.js";
import { RetainedMaterial, isReplayReason } from "./references.js";

after(stopServer);

const DAY = 86_400_000;
let n = 0;
const cid = (label: string): string => `${label}-${n++}`;
const rid = (c: string): string => `dsk-${c.repeat(20)}`;
const on = { ...RETENTION_DEFAULTS, reserveBytes: 0, derivedDays: 30 as number | null };

// Card K06: "material referenced by a resumable task or by replay is never deleted and shows as retained". A finished task's replay is read by the owner too, so what its steps cite is held.
for (const backend of backends) {
  test(`${backend.name}: a record a finished task's replay cites is held against expiry and deletion, shown as retained with the replay's step, archivable and restorable, and deletable only when the owner releases that hold by name (card K06)`, async () => {
    const world = await backend.open();
    try {
      const storage: ControllerStorage = world.storage;
      const real = Date.now();
      const options = { clock: () => new Date(real - 60 * DAY).toISOString(), pause: async () => undefined };
      const projects = await ProjectService.open(storage, { holder: "c1", ...options });
      const epoch = projects.epoch;
      const principals = PrincipalService.withEpoch(storage, epoch, options);
      const owner: Principal = await principals.authenticate((await principals.bootstrapOwner({ name: "rob" })).token);
      const project = (await projects.createProject({ commandId: cid("p"), actor: owner.id, name: "A" })).id;
      const done = (await projects.createTask({ commandId: cid("t"), actor: owner.id, projectId: project, title: "finished" })).id;
      for (const step of ["ready", "in_progress", "done"]) await projects.transitionTask({ commandId: cid("mv"), actor: owner.id, taskId: done, expectedRevision: (await projects.getTask(done))!.revision, to: step as never });
      const put = async (kind: string, id: string, body: object): Promise<void> => {
        await storage.applyOperation({ operationId: cid("put"), epoch, actor: "test", correlationId: "put", at: new Date(real - 60 * DAY).toISOString(), changes: [{ type: "create", ref: { kind, id }, body: body as never }], audit: [{ type: "test.put", subject: { kind, id }, detail: {} }], outbox: [], effects: [], timers: [], cancelTimers: [], completeDeliveries: [], completeTimers: [], settleEffects: [] } as never);
      };
      const desk = (title: string, body: string) => ({ projectId: project, taskId: done, owner: "agent:ann", kind: "note", title, body, visibility: "shared", status: "accepted" });
      const cited = rid("a"), free = rid("b"), viaExplain = rid("c");
      await put("desk-record", cited, desk("cited by a step", "The text that a replay step of the finished task points at, long enough to quote."));
      await put("desk-record", free, desk("nobody cites it", "A different record that no replay step and no resumable task needs at all."));
      await put("desk-record", viaExplain, desk("cited as evidence", "Evidence an explanation of a step names, again long enough to be quoted."));
      await put("summary-record", "sum-cited", { projectId: project, createdBy: "agent:ann", title: "s1", text: "stood in for earlier history", sources: [] });
      await put("summary-record", "sum-free", { projectId: project, createdBy: "agent:ann", title: "s2", text: "nobody needs this", sources: [] });
      const step = (seq: number, manifest: object) => ({ taskId: done, projectId: project, seq, kind: "tool-call", summary: "a step", actor: "agent:ann", at: new Date(real - 59 * DAY).toISOString(), manifest, payload: { state: "none" } });
      await put("activity-step", "act-1", step(1, { missing: false, refs: [{ kind: "desk-record", id: cited }, { kind: "job", id: "job-x" }] }));
      await put("activity-step", "act-2", step(2, { missing: false, refs: [], summaryId: "sum-cited" }));
      await put("activity-step", "act-3", step(3, { missing: true, reason: "not recorded" }));
      await put("activity-explanation", "exp-1", { taskId: done, projectId: project, seq: 1, mode: "contemporaneous", choice: "c", alternatives: [], evidence: [{ statement: "e", ref: { kind: "desk-record", id: viaExplain } }], uncertainty: "u", by: "agent:ann", at: new Date(real).toISOString() });

      const material = await RetainedMaterial.build(storage);
      assert.ok(material.complete);
      assert.match(material.why("desk-record", cited)![0]!, /cited by the replay of task .* \(step 1\)/);
      assert.match(material.why("summary-record", "sum-cited")![0]!, /step 2/);
      assert.match(material.why("desk-record", viaExplain)![0]!, /explanation of step 1/);
      assert.equal(material.why("desk-record", free), undefined);
      assert.equal(material.why("summary-record", "sum-free"), undefined);
      assert.equal((await RetainedMaterial.build(storage, { replay: false })).why("desk-record", cited), undefined, "the replay scan can be left out (a release asks for that)");

      const svc = (v = on) => RetentionService.withEpoch(storage, epoch, { settings: { effective: async () => v }, now: () => real } as never, { clock: () => new Date(real).toISOString(), pause: async () => undefined });
      // Expiry: the summary a step names is retained and shown with its reason; the free one is the only candidate.
      const preview = await svc().run(owner, {});
      assert.deepEqual(preview.candidates.map((c) => c.id), ["sum-free"]);
      assert.ok(preview.retained.some((r) => r.id === "sum-cited" && r.reasons.some(isReplayReason)), "shown as retained");
      const ran = await svc().run(owner, { dryRun: false, confirm: preview.digest! });
      assert.equal(ran.removed, 1);
      assert.ok(await storage.getAggregate({ kind: "summary-record", id: "sum-cited" }), "the cited summary is still there");
      assert.equal(await storage.getAggregate({ kind: "summary-record", id: "sum-free" }), undefined);
      assert.equal((await svc().check(owner, { kind: "desk-record", id: cited })).retained, true);
      assert.equal((await svc().check(owner, { kind: "desk-record", id: free })).retained, false);

      // Deletion: the cited record is retained and recorded as such, the free one is deleted.
      const dry = await svc().delete(owner, { commandId: cid("d"), recordId: cited, reason: "owner asked", dryRun: true });
      assert.equal(dry.status, "retained");
      const refused = await svc().delete(owner, { commandId: cid("d"), recordId: cited, reason: "owner asked" });
      assert.equal(refused.status, "retained");
      assert.ok(refused.retained!.some((r) => r.reasons.some(isReplayReason)));
      assert.equal(((await storage.getAggregate({ kind: "desk-record", id: cited }))!.body as { deleted?: unknown }).deleted, undefined);
      assert.equal((await svc().delete(owner, { commandId: cid("d"), recordId: free, reason: "owner asked" })).status, "deleted");

      // Archive keeps the original and puts it back, so a replay hold does not stop it.
      const archived = await svc().archive(owner, { commandId: cid("a"), taskId: done });
      assert.ok(archived.archived.includes(cited), "an archive of a finished task is not stopped by its replay");
      assert.equal(archived.retained.length, 0);
      assert.equal(((await storage.getAggregate({ kind: "desk-record", id: cited }))!.body as { title: string }).title, "(archived)");
      const restored = await svc().restore(owner, { commandId: cid("r"), taskId: done });
      assert.ok(restored.restored.includes(cited));
      assert.equal(((await storage.getAggregate({ kind: "desk-record", id: cited }))!.body as { title: string }).title, "cited by a step");

      // The owner may release the replay hold, and nothing else: the record is deleted and the deletion names the steps that now point at it.
      const released = await svc().delete(owner, { commandId: cid("d"), recordId: cited, reason: "owner asked, replay released", releaseReplay: true });
      assert.equal(released.status, "deleted");
      assert.ok(released.replayReleased!.some((r) => r.id === cited && r.reasons.some(isReplayReason)));
      const record = (await storage.getAggregate({ kind: "retention-deletion", id: released.deletionId! }))!.body as { replayReleased?: { id: string }[] };
      assert.ok(record.replayReleased!.some((r) => r.id === cited), "the deletion record names what the replay pointed at");
      assert.equal(((await storage.getAggregate({ kind: "desk-record", id: cited }))!.body as { title: string }).title, "");

      // A hold of a resumable task cannot be released that way.
      const live = (await projects.createTask({ commandId: cid("t"), actor: owner.id, projectId: project, title: "running" })).id;
      await projects.transitionTask({ commandId: cid("mv"), actor: owner.id, taskId: live, expectedRevision: (await projects.getTask(live))!.revision, to: "ready" as never });
      const held = rid("d");
      await put("desk-record", held, { ...desk("live", "The record of a task that can still resume, long enough to quote it."), taskId: live });
      await put("activity-step", "act-9", { ...step(1, { missing: false, refs: [{ kind: "desk-record", id: held }] }), taskId: live });
      const stays = await svc().delete(owner, { commandId: cid("d"), recordId: held, reason: "owner asked", releaseReplay: true });
      assert.equal(stays.status, "retained", "releasing the replay does not release a resumable task's hold");
      assert.ok(stays.retained!.every((r) => r.reasons.every((w) => !isReplayReason(w))));
    } finally { await world.close(); }
  });
}
