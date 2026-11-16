import assert from "node:assert/strict";
import { after, test } from "node:test";
import { DecisionService } from "../decisions/index.js";
import { DeskService } from "../context/index.js";
import { ProjectService } from "../domain/index.js";
import { backends, stopServer } from "../domain/testing/backends.js";
import { PrincipalService, type Principal } from "../security/index.js";
import type { ControllerStorage } from "../storage/types.js";
import { RETENTION_DEFAULTS, RetentionService, describeRun } from "./index.js";
import { CATALOG_SOURCES_UNREAD, PLAN_LINK_REASON } from "./service.js";
import { planSubjectIds } from "./references.js";

after(stopServer);

// Card K06b follow-up (T5b): the read of the decision links has no cap (it pages to the end), a link that names an empty, archived or missing plan holds that ID without a crash or a blanking, a malformed link record
// cannot stop the read, and a run that could not check everything says so in plain words.
const DAY = 86_400_000;
let n = 0;
const cid = (label: string): string => `${label}-${n++}`;
const off = { ...RETENTION_DEFAULTS, reserveBytes: 0, thinkingAuto: false };

test("planSubjectIds reads only well-formed plan subjects and never throws on a malformed record", () => {
  assert.deepEqual(planSubjectIds({ links: [{ subject: { kind: "plan", id: "a" } }, { subject: { kind: "plan", id: "" } }, { subject: { kind: "task", id: "b" } }, null, 7, {}, { subject: null }, { subject: { kind: "plan", id: 4 } }] }), ["a"]);
  for (const body of [undefined, null, 5, "x", {}, { links: null }, { links: "plan" }, { links: { 0: { subject: { kind: "plan", id: "a" } } } }]) assert.deepEqual(planSubjectIds(body), []);
});

for (const backend of backends) {
  test(`${backend.name}: the link read pages past one page with no cap, a link to an empty, archived or missing plan holds it, a malformed link record stops nothing, and a run that could not finish says so (card K06b follow-up T5b)`, async () => {
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
      const decisionId = (decided as { id: string }).id;
      const link = (task: string, id: string) => decisions.link(ann, { commandId: cid("lk"), taskId: task, subject: { kind: "plan", id }, decisions: [decisionId] } as never);
      const plant = async (id: string, links: unknown, task?: string): Promise<void> => { await storage.applyOperation({ operationId: cid("plant"), epoch, actor: "test", correlationId: "plant", at: options.clock(), changes: [{ type: "create", ref: { kind: "decision-reliance", id }, body: { taskId: task ?? "none", projectId: project, links } as never }], audit: [{ type: "test.plant", detail: {} }], outbox: [], effects: [], timers: [], cancelTimers: [], completeDeliveries: [], completeTimers: [], settleEffects: [] } as never); };
      const desk = async (id: string) => (await storage.getAggregate({ kind: "desk-record", id }))!.body as { title: string; body: string };
      const planted = (id: string, kind = "plan") => ({ id: `lnk-${id}`, subject: { kind, id }, decisionId, version: 1, topic: "database", state: "current", linkedBy: ann.id, linkedAt: options.clock() });
      const at = (days: number, limit?: number, v: object = {}) => RetentionService.withEpoch(storage, epoch, { settings: { effective: async () => ({ ...off, ...v }) }, now: () => real + days * DAY, catalogScanLimit: limit } as never, { clock: () => new Date(real + days * DAY).toISOString(), pause: async () => undefined });

      // One finished task: a plan whose text is empty (named by a link), a plan with a link far past the first page of link records, an unlinked plan, and a link to a plan that does not exist.
      const t1 = await newTask();
      const empty = await write(t1, "plan", "text that is emptied below");
      const far = await write(t1, "plan", "plan named on a late page 9901");
      const free = await write(t1, "plan", "plan without a link 9902");
      const rec = (await storage.getAggregate({ kind: "desk-record", id: empty }))!;
      await storage.applyOperation({ operationId: cid("blank"), epoch, actor: "test", correlationId: "blank", at: options.clock(), changes: [{ type: "update", ref: { kind: "desk-record", id: empty }, expectedRevision: rec.revision, body: { ...rec.body, body: "" } as never }], audit: [{ type: "test.blank", detail: {} }], outbox: [], effects: [], timers: [], cancelTimers: [], completeDeliveries: [], completeTimers: [], settleEffects: [] } as never);
      await finish(t1);
      await link(t1, empty);
      await plant("drl-missing", [planted("no-such-plan")], t1);
      // Malformed link records: none of them may stop the read or hold anything.
      await plant("drl-bad-1", [null, 7, {}, { subject: null }, { subject: { kind: "plan", id: "" } }, { subject: { kind: "plan", id: 5 } }]);
      await plant("drl-bad-2", "not a list");
      await plant("drl-bad-3", null);
      // 1200 filler records (more than two pages of 500) sort before the one that names `far`.
      const filler = Array.from({ length: 1200 }, (_, i) => ({ type: "create" as const, ref: { kind: "decision-reliance", id: `drl-a-${String(i).padStart(5, "0")}` }, body: { links: [] } as never }));
      for (let i = 0; i < filler.length; i += 100) await storage.applyOperation({ operationId: cid("fill"), epoch, actor: "test", correlationId: "fill", at: options.clock(), changes: filler.slice(i, i + 100), audit: [{ type: "test.fill", detail: {} }], outbox: [], effects: [], timers: [], cancelTimers: [], completeDeliveries: [], completeTimers: [], settleEffects: [] } as never);
      await plant("drl-zzz-last", [planted(far)], t1);

      const rule = { scratchArchiveDays: 30 };
      const preview = await at(0, undefined, rule).run(owner, {});
      assert.equal(preview.partial, false, "the read finished: nothing is partial");
      assert.deepEqual(preview.candidates.map((c) => c.id), [free], "only the unlinked plan is a candidate");
      for (const id of [empty, far]) assert.deepEqual(preview.retained.filter((r) => r.id === id).map((r) => r.reasons), [[PLAN_LINK_REASON]]);
      assert.doesNotMatch(describeRun(preview), /could be checked/);
      const ran = await at(0, undefined, rule).run(owner, { dryRun: false, confirm: preview.digest! });
      assert.equal(ran.removed, 1); assert.equal(ran.partial, false);
      assert.equal((await desk(free)).title, "(archived)");
      assert.deepEqual([(await desk(empty)).title, (await desk(empty)).body, (await desk(far)).title, (await desk(far)).body], ["work", "", "work", "plan named on a late page 9901"], "the empty plan is not blanked or archived, the far one stays whole");

      // A read that cannot finish (a limit smaller than the list, as a stand-in for a failed read) holds back everything and the owner's text says why.
      const t2 = await newTask();
      const other = await write(t2, "plan", "plan 9903");
      await finish(t2);
      const blind = await at(0, 500, rule).run(owner, {});
      assert.deepEqual(blind.candidates, []); assert.equal(blind.partial, true);
      assert.match(describeRun(blind), /Not everything could be checked.*nothing unchecked was removed/);
      const kept = await at(0, 500).archive(owner, { commandId: cid("a"), taskId: t2 });
      assert.deepEqual(kept.archived, []);
      assert.deepEqual(kept.retained.map((r) => [r.id, r.reasons.join()]), [[other, CATALOG_SOURCES_UNREAD]]);
      assert.equal((await desk(other)).title, "work");
      // Without the limit the same plan archives (the read has no cap).
      assert.deepEqual((await at(0).archive(owner, { commandId: cid("a"), taskId: t2 })).archived, [other]);
    } finally { await world.close(); }
  });
}
