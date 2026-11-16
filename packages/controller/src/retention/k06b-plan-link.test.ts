import assert from "node:assert/strict";
import { after, test } from "node:test";
import { DecisionService } from "../decisions/index.js";
import { DeskService } from "../context/index.js";
import { ProjectService } from "../domain/index.js";
import { backends, stopServer } from "../domain/testing/backends.js";
import { PrincipalService, type Principal } from "../security/index.js";
import type { ControllerStorage } from "../storage/types.js";
import { RETENTION_DEFAULTS, RetentionService } from "./index.js";
import { CATALOG_SOURCES_UNREAD, PLAN_LINK_REASON } from "./service.js";

after(stopServer);

// Card K06b follow-up (T5): a decision link may name a finished task's private `plan` desk record as its subject. The scratch rule and the owner's task archive must keep that record, so the link never points at an empty
// record. A plan with no link still goes. The read of the links is bounded and fails closed, and is read again before every removal batch and inside every guarded archive.
const DAY = 86_400_000;
let n = 0;
const cid = (label: string): string => `${label}-${n++}`;
const off = { ...RETENTION_DEFAULTS, reserveBytes: 0, thinkingAuto: false };

for (const backend of backends) {
  test(`${backend.name}: scratch archive and purge, and the owner's task archive, keep a plan a decision link names; a plan with no link still goes; an unfinished link read removes nothing; a link made while the run goes is held (card K06b follow-up T5)`, async () => {
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
      const newTask = async (): Promise<string> => (await projects.createTask({ commandId: cid("t"), actor: owner.id, projectId: project, title: "T" })).id;
      const finish = async (task: string): Promise<void> => { for (const id of ["ready", "in_progress", "done"]) await projects.transitionTask({ commandId: cid("mv"), actor: owner.id, taskId: task, expectedRevision: (await projects.getTask(task))!.revision, to: id as never }); };
      await principals.enroll(owner, { commandId: cid("e"), kind: "agent", name: "ann", grants: [{ action: "desk.write", project }, { action: "desk.read", project }, { action: "attempt.work", project }] });
      const ann = await principals.authenticate((await principals.issueCredential(owner, "agent:ann")).token);
      const desks = DeskService.withEpoch(storage, epoch, options);
      const decisions = DecisionService.withEpoch(storage, epoch, {}, options);
      const write = async (task: string, kind: string, body: string): Promise<string> => (await desks.write(ann, { commandId: cid("w"), projectId: project, taskId: task, kind, title: "work", body, visibility: "private", status: "accepted" } as never)).id;
      const decided = await decisions.record(owner, { commandId: cid("dec"), projectId: project, category: "decision", topic: "database", statement: "Use PostgreSQL", wording: "We will use PostgreSQL", source: { channel: "direct" }, basedOn: 0 } as never);
      assert.equal(decided.recorded, true);
      const decisionId = (decided as { id: string }).id;
      const link = (task: string, kind: string, id: string) => decisions.link(ann, { commandId: cid("lk"), taskId: task, subject: { kind, id }, decisions: [decisionId] } as never);
      const title = async (id: string): Promise<string> => ((await storage.getAggregate({ kind: "desk-record", id }))!.body as { title: string }).title;

      let breakLinks = false; let scanLimit: number | undefined; let hook: (() => Promise<void>) | undefined; let archiveHook: (() => Promise<void>) | undefined; let listHook: ((kind: string) => Promise<void>) | undefined;
      const guarded = new Proxy(storage, { get: (t, k) => { const v = (t as never)[k] as unknown; if (k === "listAggregates") return async (kind: string, o: never) => { if (breakLinks && kind === "decision-reliance") throw new Error("link read failed"); const page = await (t as ControllerStorage).listAggregates(kind, o); await listHook?.(kind); return page; }; return typeof v === "function" ? (v as (...a: unknown[]) => unknown).bind(t) : v; } }) as ControllerStorage;
      const at = (days: number, v: object = {}) => RetentionService.withEpoch(guarded, epoch, { settings: { effective: async () => ({ ...off, ...v }) }, now: () => real + days * DAY, catalogScanLimit: scanLimit, beforeBatch: async () => { const h = hook; hook = undefined; await h?.(); }, beforeArchiveWrite: async () => { const h = archiveHook; archiveHook = undefined; await h?.(); } } as never, { clock: () => new Date(real + days * DAY).toISOString(), pause: async () => undefined });

      // Task 1 is cleaned by the scratch rule: a linked plan, an unlinked plan, a plain note, and a plan that a link names only after the preview.
      const t1 = await newTask();
      const linked = await write(t1, "plan", "plan with a link 7701"), free = await write(t1, "plan", "plan without a link 7702"), note = await write(t1, "note", "note 7703"), lateLinked = await write(t1, "plan", "linked later 7704");
      await link(t1, "plan", linked);
      await finish(t1);

      const preview = await at(0, { scratchArchiveDays: 30 }).run(owner, {});
      assert.deepEqual(preview.candidates.map((c) => c.id).sort(), [free, lateLinked, note].sort());
      assert.deepEqual(preview.retained.filter((r) => r.id === linked).map((r) => r.reasons), [[PLAN_LINK_REASON]]);

      // An unfinished read of the links (it fails): nothing is a candidate and the run says it is partial.
      breakLinks = true;
      const blind = await at(0, { scratchArchiveDays: 30 }).run(owner, {});
      assert.deepEqual(blind.candidates, []); assert.equal(blind.partial, true);
      breakLinks = false;

      // The bounded read reaches its limit (500 reliance records with a limit of 500): the same.
      const filler = Array.from({ length: 500 }, (_, i) => ({ type: "create" as const, ref: { kind: "decision-reliance", id: `drl-filler-${i}` }, body: { links: [] } as never }));
      for (let i = 0; i < filler.length; i += 100) await storage.applyOperation({ operationId: cid("fill"), epoch, actor: "test", correlationId: "fill", at: options.clock(), changes: filler.slice(i, i + 100), audit: [{ type: "test.fill", detail: {} }], outbox: [], effects: [], timers: [], cancelTimers: [], completeDeliveries: [], completeTimers: [], settleEffects: [] } as never);
      scanLimit = 500;
      const bounded = await at(0, { scratchArchiveDays: 30 }).run(owner, {});
      assert.deepEqual(bounded.candidates, []); assert.equal(bounded.partial, true);
      scanLimit = undefined;

      // A link made while the run goes (after the preview) is held when the batch is reached; the other records are archived.
      hook = async () => { await link(t1, "plan", lateLinked); };
      const ran = await at(0, { scratchArchiveDays: 30 }).run(owner, { dryRun: false, confirm: preview.digest! });
      assert.equal(ran.removed, 2);
      assert.equal(await title(free), "(archived)"); assert.equal(await title(note), "(archived)");
      for (const id of [linked, lateLinked]) assert.equal(await title(id), "work", "a plan a link names stays whole");
      assert.ok(ran.retained.some((r) => r.id === lateLinked && r.reasons.includes(PLAN_LINK_REASON)), "the plan linked mid-run is shown as held");
      assert.deepEqual((await at(0, { scratchArchiveDays: 30 }).run(owner, {})).candidates, [], "nothing else to archive");

      // Purge, much later: the archived scratch goes, the linked plans stay.
      const pv = await at(80, { scratchArchiveDays: 30, scratchPurgeDays: 30 }).run(owner, {});
      assert.deepEqual(pv.candidates.map((c) => [c.kind, c.id]).sort(), [["scratch-purge", free], ["scratch-purge", note]].sort());
      hook = async () => { breakLinks = true; };
      const stopped = await at(80, { scratchArchiveDays: 30, scratchPurgeDays: 30 }).run(owner, { dryRun: false, confirm: pv.digest! });
      breakLinks = false;
      assert.equal(stopped.removed, 0, "the links could not be read when the batch was reached: nothing removed");
      assert.equal(stopped.partial, true);
      assert.ok(stopped.retained.some((r) => r.id === free && r.reasons.includes(CATALOG_SOURCES_UNREAD)));
      assert.equal(await title(free), "(archived)");
      // A link made after the batch's own read and before the deletion's check holds the deletion (the deletion records that it did).
      let lists = 0;
      listHook = async (kind) => { if (kind !== "decision-reliance") return; lists += 1; if (lists === 4) { listHook = undefined; await link(t1, "plan", free); } };
      const gap = await at(80, { scratchArchiveDays: 30, scratchPurgeDays: 30 }).run(owner, { dryRun: false, confirm: pv.digest! });
      listHook = undefined;
      assert.equal(await title(free), "(archived)", "the link made inside the gap keeps the record");
      assert.ok(gap.retained.some((r) => r.id === free && r.kind === "scratch-purge" && r.reasons.includes(PLAN_LINK_REASON)));
      assert.equal(gap.removed, 1, "the unlinked note is removed");
      assert.equal(await title(note), "");
      for (const id of [linked, lateLinked]) assert.equal(await title(id), "work");

      // The owner's archive of a task: the linked plan is held, a plain plan and a note go. A link made inside the first guarded archive holds that plan; a link read that fails there keeps the record.
      const t2 = await newTask();
      const keep = await write(t2, "plan", "kept plan 7711"), plain = await write(t2, "plan", "plain plan 7712"), gapPlan = await write(t2, "plan", "gap plan 7713"), gapNote = await write(t2, "note", "gap note 7714");
      await link(t2, "plan", keep);
      await finish(t2);
      archiveHook = async () => { await link(t2, "plan", gapPlan); };
      const archived = await at(0).archive(owner, { commandId: cid("a"), taskId: t2 });
      assert.equal(archiveHook, undefined, "the gap was reached");
      assert.deepEqual(archived.archived.sort(), [gapNote, plain].sort());
      assert.deepEqual(archived.retained.map((r) => [r.id, r.reasons.join()]).sort(), [[gapPlan, PLAN_LINK_REASON], [keep, PLAN_LINK_REASON]].sort());
      for (const id of [keep, gapPlan]) assert.equal(await title(id), "work");
      assert.equal(await title(plain), "(archived)");
      const t3 = await newTask();
      const blindPlan = await write(t3, "plan", "plan 7721");
      await finish(t3);
      archiveHook = async () => { breakLinks = true; };
      const noRead = await at(0).archive(owner, { commandId: cid("a"), taskId: t3 }).finally(() => { breakLinks = false; });
      assert.deepEqual(noRead.archived, []);
      assert.deepEqual(noRead.retained.map((r) => [r.id, r.reasons.includes(CATALOG_SOURCES_UNREAD)]), [[blindPlan, true]]);
      assert.equal(await title(blindPlan), "work");

      // The owner's own request to delete a named record is not held (unchanged).
      const del = await at(0).delete(owner, { commandId: cid("d"), recordId: keep, reason: "owner removes it" });
      assert.equal(del.status, "deleted");

      // Links in any state hold the plan (a superseded link still names it), and only the subject kind `plan` holds a record: a link of another kind whose ID equals a desk record's does not (planted directly,
      // since the decision service refuses such a link).
      const t4 = await newTask();
      const oldLinked = await write(t4, "plan", "plan behind a superseded link 7731"), otherKind = await write(t4, "plan", "named only by a review link 7732");
      await finish(t4);
      const planted = (kind: string, id: string, state: string) => ({ id: `lnk-${kind}-${id}`, subject: { kind, id }, decisionId, version: 1, topic: "database", state, linkedBy: ann.id, linkedAt: options.clock() });
      await storage.applyOperation({ operationId: cid("plant"), epoch, actor: "test", correlationId: "plant", at: options.clock(), changes: [{ type: "create", ref: { kind: "decision-reliance", id: "drl-planted-t4" }, body: { taskId: t4, projectId: project, links: [planted("plan", oldLinked, "superseded"), planted("review", otherKind, "current")], revalidations: 0, followUps: [] } }], audit: [{ type: "test.plant", detail: {} }], outbox: [], effects: [], timers: [], cancelTimers: [], completeDeliveries: [], completeTimers: [], settleEffects: [] } as never);
      const mixed = await at(0).archive(owner, { commandId: cid("a"), taskId: t4 });
      assert.deepEqual(mixed.archived, [otherKind], "a link of another subject kind does not hold a desk record");
      assert.deepEqual(mixed.retained.map((r) => [r.id, r.reasons.join()]), [[oldLinked, PLAN_LINK_REASON]], "a superseded link still holds its plan");
      assert.equal(await title(oldLinked), "work"); assert.equal(await title(otherKind), "(archived)");
    } finally { await world.close(); }
  });
}
