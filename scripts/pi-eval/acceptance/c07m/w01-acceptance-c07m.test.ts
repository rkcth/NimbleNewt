import assert from "node:assert/strict";
import { after, test } from "node:test";
import { BlockerService, DomainError, ProjectService, type DomainErrorCode } from "../domain/index.js";
import { backends, stopServer } from "../domain/testing/backends.js";
import { PrincipalService, type Grant } from "../security/index.js";
import { ContextEnforcementService, DeskService, HistoryService, RetrievalService, type HandoffFacts } from "./index.js";

// W01 acceptance for card C07m: the two new reads of the context service, `latestHandoffFor` and `readHandoff`, as the CONTRACT pins them.
after(stopServer);

const options = { clock: () => "2026-10-22T10:00:00.000Z", pause: async () => undefined };
let n = 0;
const cid = (label: string): string => `${label}-${n++}`;
const refuses = async (code: DomainErrorCode, run: () => Promise<unknown>): Promise<void> => {
  await assert.rejects(run, (error: unknown) => { assert.ok(error instanceof DomainError, String(error)); assert.equal(error.code, code, error.message); return true; });
};
const ABSENT = "hof-bbbbbbbbbbbbbbbbbbbb";
const NOT_A_NOTE = "ctx-note-bbbbbbbbbbbbbbbbbbbb";
const MALFORMED = "not an id";
const facts = async (): Promise<HandoffFacts> => ({ task: "the task", endedBecause: "", effects: [], artifacts: [], lastKnownState: "half done", nextStep: "finish it" });

for (const backend of backends) {
  test(`${backend.name}: the dispatcher reads a task's latest note as a record, and whoever may work on the task reads a note whole by its ID`, async () => {
    const world = await backend.open();
    try {
      const projects = await ProjectService.open(world.storage, { holder: "c1", ...options });
      const principals = PrincipalService.withEpoch(world.storage, projects.epoch, options);
      const owner = await principals.authenticate((await principals.bootstrapOwner({ name: "rob" })).token);
      const agent = async (nm: string, grants: Grant[]) => {
        await principals.enroll(owner, { commandId: cid("e"), kind: "agent", name: nm, grants });
        return principals.authenticate((await principals.issueCredential(owner, `agent:${nm}`)).token);
      };
      const a = (await projects.createProject({ commandId: cid("pa"), actor: "owner:rob", name: "A" })).id;
      const b = (await projects.createProject({ commandId: cid("pb"), actor: "owner:rob", name: "B" })).id;
      const t = (await projects.createTask({ commandId: cid("t"), actor: "owner:rob", projectId: a, title: "the task" })).id;
      const histories = HistoryService.withEpoch(world.storage, projects.epoch, options);
      const desks = DeskService.withEpoch(world.storage, projects.epoch, options);
      const retrieval = RetrievalService.withEpoch(world.storage, projects.epoch, desks, histories, options);
      const blockers = BlockerService.withEpoch(world.storage, projects.epoch, options);
      const enf = ContextEnforcementService.withEpoch(world.storage, projects.epoch, { blockers, retrieval }, options);
      const rights = (p: string): Grant[] => [{ action: "desk.write", project: p }, { action: "desk.read", project: p }, { action: "attempt.work", project: p }];
      const ann = await agent("ann", rights(a));
      const ben = await agent("ben", [{ action: "desk.read", project: a }, { action: "attempt.work", project: a }]);
      const eve = await agent("eve", rights(b));
      await principals.enroll(owner, { commandId: cid("e"), kind: "host", name: "h1", grants: [{ action: "desk.read", project: a }, { action: "desk.write", project: a }] });
      const host = await principals.authenticate((await principals.issueCredential(owner, "host:h1")).token);

      assert.equal(await enf.latestHandoffFor(owner, t), undefined, "a task with no note has nothing to name");
      // The controller's note of an attempt that ended without one, then the attempt's own (late) note of the same attempt, which becomes the latest.
      const ctrl = await enf.ensureHandoff(owner, { taskId: t, attemptId: "att-1", endedBecause: "the attempt died" }, facts);
      assert.equal(ctrl.source, "controller");
      assert.deepEqual(await enf.latestHandoffFor(owner, t), { id: ctrl.id, attemptId: "att-1", source: "controller" }, "the record only, without its text");
      const late = await enf.recordHandoff(ann, { taskId: t, attemptId: "att-1", text: "late own hand-off token=ghp_abcdefghijklmnopqrstuvwxyz0123456789" });
      assert.deepEqual(await enf.latestHandoffFor(owner, t), { id: late.id, attemptId: "att-1", source: "attempt" });
      assert.deepEqual(await enf.latestHandoffFor(host, t), { id: late.id, attemptId: "att-1", source: "attempt" }, "a host is on the dispatcher's gate too");
      // An agent is not the dispatcher, whatever its grants; a task that does not exist is not found.
      for (const who of [ann, ben, eve]) await refuses("forbidden", () => enf.latestHandoffFor(who, t));
      await refuses("not_found", () => enf.latestHandoffFor(owner, "task-aaaaaaaaaaaaaaaaaaaa"));

      // One note by its ID: exactly the documented fields, credentials removed.
      const whole = (await enf.readHandoff(owner, ctrl.id))!;
      assert.deepEqual(Object.keys(whole).sort(), ["attemptId", "endedBecause", "id", "source", "taskId", "text"]);
      assert.deepEqual([whole.id, whole.taskId, whole.attemptId, whole.source, whole.text], [ctrl.id, t, "att-1", "controller", ctrl.text]);
      assert.equal(typeof whole.endedBecause, "string");
      const own = (await enf.readHandoff(ben, late.id))!;
      assert.deepEqual([own.source, own.taskId], ["attempt", t], "whoever may work on the task reads it");
      assert.match(own.text, /late own hand-off/);
      assert.ok(!own.text.includes("ghp_abcdefgh"), "credentials are removed");
      assert.equal((await enf.readHandoff(ann, late.id))?.id, late.id);
      // Someone who may not work on the task, a note that is not there and an ID that is not a note's all read as nothing.
      assert.equal(await enf.readHandoff(eve, late.id), undefined);
      assert.equal(await enf.readHandoff(owner, ABSENT), undefined);
      assert.equal(await enf.readHandoff(owner, NOT_A_NOTE), undefined);
      assert.equal(await enf.readHandoff(owner, MALFORMED), undefined);
    } finally { await world.close(); }
  });
}
