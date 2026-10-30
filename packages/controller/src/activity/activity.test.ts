import assert from "node:assert/strict";
import { after, test } from "node:test";
import { DomainError, type DomainErrorCode } from "../domain/errors.js";
import { ProjectService } from "../domain/service.js";
import { backends, stopServer } from "../domain/testing/backends.js";
import { PrincipalService, type Grant } from "../security/index.js";
import { ActivityService } from "./index.js";

after(stopServer);

let now = Date.parse("2026-10-28T10:00:00.000Z");
const options = { clock: () => new Date((now += 1000)).toISOString(), pause: async () => undefined };
let n = 0;
const cid = (label: string): string => `${label}-${n++}`;
const refuses = async (code: DomainErrorCode, run: () => Promise<unknown>): Promise<void> => {
  await assert.rejects(run, (error: unknown) => { assert.ok(error instanceof DomainError, String(error)); assert.equal(error.code, code, error.message); return true; });
};

for (const backend of backends) {
  test(`${backend.name}: activity records and explanations`, async () => {
    const world = await backend.open();
    try {
      const projects = await ProjectService.open(world.storage, { holder: "c1", ...options });
      const principals = PrincipalService.withEpoch(world.storage, projects.epoch, options);
      const owner = await principals.authenticate((await principals.bootstrapOwner({ name: "rob" })).token);
      const make = async (nm: string, grants: Grant[]) => { await principals.enroll(owner, { commandId: cid("e"), kind: "agent", name: nm, grants }); return principals.authenticate((await principals.issueCredential(owner, `agent:${nm}`)).token); };
      const project = (await projects.createProject({ commandId: cid("p"), actor: owner.id, name: "A" })).id;
      const task = (await projects.createTask({ commandId: cid("t"), actor: owner.id, projectId: project, title: "one" })).id;
      const worker = await make("ann", [{ action: "attempt.work", project }]);
      const auditor = await make("aud", [{ action: "history.read", project }]);
      const stranger = await make("zed", [{ action: "task.read", project }]);
      const svc = ActivityService.withEpoch(world.storage, projects.epoch, options);

      // Steps are numbered in order, each with its exact manifest; a repeat is the same step.
      const id = cid("r");
      const one = await svc.record(worker, { commandId: id, taskId: task, kind: "model-selected", summary: "chose the local 70B route", manifest: { refs: [{ kind: "summary", id: "sum-1", version: "3" }, { kind: "record", id: "dsk-1" }], summaryId: "sum-1" } });
      assert.deepEqual([one.seq, one.replayed], [1, false]);
      assert.deepEqual(await svc.record(worker, { commandId: id, taskId: task, kind: "model-selected", summary: "chose the local 70B route", manifest: { refs: [{ kind: "summary", id: "sum-1", version: "3" }, { kind: "record", id: "dsk-1" }], summaryId: "sum-1" } }), { ...one, replayed: true });
      const two = await svc.record(worker, { commandId: cid("r"), taskId: task, kind: "tool-call", summary: "ran the tests", payload: { text: "result: ok; key sk-live-ABCDEFGHIJKLMNOPQRSTUVWX1234 was in the env" } });
      assert.equal(two.seq, 2);
      const three = await svc.record(owner, { commandId: cid("r"), taskId: task, kind: "owner-message", summary: "asked for the summary", payload: { missing: true, reason: "the message store was pruned" } });
      assert.equal(three.seq, 3);
      const listed = await svc.steps(auditor, task);
      assert.deepEqual(listed.steps.map((s) => ("kind" in s ? s.kind : "gone")), ["model-selected", "tool-call", "owner-message"]);
      // `tail` asks for the last steps only.
      assert.deepEqual((await svc.steps(auditor, task, { tail: true, limit: 2 })).steps.map((s) => s.seq), [2, 3]);
      assert.deepEqual((await svc.steps(auditor, task, { tail: true, limit: 50 })).steps.map((s) => s.seq), [1, 2, 3]);
      // The project's recent steps across its tasks, newest first; by actor or time; read only; the history right is needed.
      const other = (await projects.createTask({ commandId: cid("t"), actor: owner.id, projectId: project, title: "two" })).id;
      const elsewhere = (await projects.createProject({ commandId: cid("p"), actor: owner.id, name: "B" })).id;
      const foreign = (await projects.createTask({ commandId: cid("t"), actor: owner.id, projectId: elsewhere, title: "three" })).id;
      await svc.record(owner, { commandId: cid("r"), taskId: other, kind: "owner-message", summary: "second task note" });
      await svc.record(owner, { commandId: cid("r"), taskId: foreign, kind: "owner-message", summary: "another project" });
      const tl = await svc.timeline(auditor, project, { limit: 100 });
      assert.ok(tl.steps.some((x) => x.taskId === other && x.summary === "second task note"));
      assert.ok(tl.steps.every((x) => x.taskId !== foreign), "another project's steps are not in it");
      assert.ok(tl.steps.every((x, i) => i === 0 || tl.steps[i - 1]!.at >= x.at), "newest first");
      assert.deepEqual((await svc.timeline(auditor, project, { agent: "no-such", limit: 5 })).steps, []);
      const mine = (await svc.timeline(auditor, project, { agent: owner.id })).steps;
      assert.ok(mine.length > 0 && mine.every((x) => x.actor === owner.id));
      assert.ok((await svc.timeline(auditor, project, { since: "2000-01-01T00:00:00Z" })).steps.length > 0, "since keeps steps at or after the time");
      assert.ok((await svc.timeline(owner, project)).scanned >= 2, "the project's tasks were counted");
      await refuses("not_found", () => svc.timeline(worker, project));
      // Past 25 tasks only the most recently active are read, whatever their IDs; the view says it was cut.
      const busy = (await projects.createProject({ commandId: cid("p"), actor: owner.id, name: "Busy" })).id;
      let lastTask = "";
      for (let i = 0; i < 27; i++) {
        lastTask = (await projects.createTask({ commandId: cid("t"), actor: owner.id, projectId: busy, title: `t${i}` })).id;
        await svc.record(owner, { commandId: cid("r"), taskId: lastTask, kind: "owner-message", summary: `note ${i}` });
        now += 1000;
      }
      const many = await svc.timeline(owner, busy, { limit: 100 });
      assert.equal(many.scanned, 27);
      assert.equal(many.truncated, true);
      assert.equal(many.steps.length, 25, "25 tasks were read");
      assert.equal(many.steps[0]!.taskId, lastTask, "the most recent task is first");
      assert.ok(!many.steps.some((x) => x.summary === "note 0" || x.summary === "note 1"), "the two least recent tasks are the ones left out");
      assert.deepEqual((await svc.timeline(auditor, project, { since: "2999-01-01T00:00:00Z" })).steps, []);
      assert.equal((await svc.timeline(auditor, project, { limit: 1 })).steps.length, 1);
      await refuses("not_found", () => svc.timeline(stranger, project));
      await refuses("invalid_command", () => svc.timeline(auditor, project, { since: "not a time" }));
      // A secret that straddles the cut at 300 characters is redacted whole before the cut, so no half of it is kept; a longer summary is clipped, not refused.
      const straddle = await svc.record(worker, { commandId: cid("r"), taskId: task, kind: "tool-call", summary: `${"x".repeat(285)} key sk-live-ABCDEFGHIJKLMNOPQRSTUVWX1234 and more words after it` });
      const stored = (await svc.steps(auditor, task, { after: straddle.seq - 1, limit: 1 })).steps[0] as { summary: string };
      assert.ok(stored.summary.length <= 300);
      assert.ok(!/sk-live|sk-li|ABCDEF/.test(stored.summary), stored.summary.slice(270));
      assert.equal((await svc.record(worker, { commandId: cid("r"), taskId: task, kind: "tool-call", summary: "y".repeat(3000) })).replayed, false);
      const emoji = await svc.record(worker, { commandId: cid("r"), taskId: task, kind: "tool-call", summary: `${"e".repeat(299)}😀 after` });
      assert.ok(!/[\ud800-\udbff]$/.test(((await svc.steps(auditor, task, { after: emoji.seq - 1, limit: 1 })).steps[0] as { summary: string }).summary), "a cut never leaves half of a character");
      await refuses("invalid_command", () => svc.record(worker, { commandId: cid("r"), taskId: task, kind: "tool-call", summary: "z".repeat(4001) }));
      const s1 = listed.steps[0] as { manifest: { missing: boolean; refs?: unknown[]; summaryId?: string } };
      assert.deepEqual([s1.manifest.missing, s1.manifest.refs?.length, s1.manifest.summaryId], [false, 2, "sum-1"]);
      const s2 = listed.steps[1] as { manifest: { missing: boolean }; payload: { state: string; redactions: number } };
      assert.equal(s2.manifest.missing, true, "no manifest is marked missing, not empty");
      assert.deepEqual([s2.payload.state, s2.payload.redactions > 0], ["stored", true]);
      assert.equal((listed.steps[2] as { payload: { state: string } }).payload.state, "missing");
      assert.deepEqual((await svc.steps(auditor, task, { limit: 2 })).next, 2);

      // Sensitive content is under access control and redacted.
      assert.doesNotMatch((await svc.payload(auditor, task, 2))!.text, /sk-live/);
      await refuses("not_found", () => svc.payload(worker, task, 2));
      await refuses("not_found", () => svc.payload(stranger, task, 2));
      const open = await svc.record(worker, { commandId: cid("r"), taskId: task, kind: "approval", summary: "approved the push", payload: { text: "approved by rob", sensitive: false } });
      assert.equal((await svc.payload(worker, task, open.seq))!.text, "approved by rob");
      await refuses("not_found", () => svc.steps(stranger, task));
      await refuses("forbidden", () => svc.record(stranger, { commandId: cid("r"), taskId: task, kind: "lifecycle", summary: "x" }));

      // Explanations: choice, alternatives, evidence, uncertainty; never thinking.
      const ex = { taskId: task, seq: 1, choice: "use the local route", alternatives: [{ option: "hosted route", whyNot: "the task is private" }], evidence: [{ statement: "the task's audience is private", ref: { kind: "record", id: "dsk-1" } }], uncertainty: "the local model may be slower" };
      await svc.explain(worker, { commandId: cid("x"), ...ex });
      await refuses("invalid_command", () => svc.explain(worker, { commandId: cid("x"), ...ex, thinking: "Let me think step by step..." } as never).catch((e: DomainError) => { assert.match(e.message, /never recorded as an explanation/); throw e; }));
      await refuses("invalid_command", () => svc.explain(worker, { commandId: cid("x"), ...ex, alternatives: [] }));
      await refuses("not_found", () => svc.explain(worker, { commandId: cid("x"), ...ex, seq: 99 }));
      assert.equal((await svc.explanations(auditor, task, 1)).length, 1);

      // A retrospective explanation is separate, labelled, grounded in records, and honest when they are silent.
      const later1 = await svc.explainLater(auditor, { commandId: cid("l"), taskId: task, seq: 1 });
      assert.deepEqual([later1.explanation.mode, later1.explanation.grounded], ["retrospective", true]);
      assert.match(later1.explanation.choice, /use the local route/);
      const later2 = await svc.explainLater(auditor, { commandId: cid("l"), taskId: task, seq: 2 });
      assert.deepEqual([later2.explanation.grounded, later2.explanation.alternatives.length], [false, 0]);
      assert.match(later2.explanation.choice, /cannot explain/);
      const manifestOnly = await svc.record(worker, { commandId: cid("r"), taskId: task, kind: "harness-selected", summary: "picked pi", manifest: { refs: [{ kind: "catalog-version", id: "cav-1" }] } });
      const later3 = await svc.explainLater(auditor, { commandId: cid("l"), taskId: task, seq: manifestOnly.seq });
      assert.match(later3.explanation.choice, /do not say why/);
      assert.equal((await svc.explanations(auditor, task, manifestOnly.seq)).length, 0, "retrospective ones are not passed off as written at the time");

      // Corrections append and never rewrite.
      const before = JSON.stringify((await svc.steps(auditor, task)).steps[1]);
      await svc.correct(owner, { commandId: cid("k"), taskId: task, seq: 2, note: "the tests ran on the old checkout" });
      assert.equal(JSON.stringify((await svc.steps(auditor, task)).steps[1]).replace('"corrections":1', '"corrections":0'), before);
      // A repeat of the same correction is the same one; another task's corrections and explanations are not read.
      const kid = cid("k");
      await svc.correct(owner, { commandId: kid, taskId: task, seq: 1, note: "first" });
      assert.equal((await svc.correct(owner, { commandId: kid, taskId: task, seq: 1, note: "first" })).replayed, true);
      assert.equal((await svc.corrections(auditor, task, 1)).length, 1);
      assert.deepEqual(await svc.explanations(auditor, (await projects.createTask({ commandId: cid("t"), actor: owner.id, projectId: project, title: "none" })).id), []);
      const cs = await svc.corrections(auditor, task, 2);
      assert.deepEqual([cs.length, cs[0]!.by, cs[0]!.note], [1, owner.id, "the tests ran on the old checkout"]);
      await refuses("forbidden", () => svc.correct(worker, { commandId: cid("k"), taskId: task, seq: 2, note: "x" }));

      // Unavailable ranges stay in the list, without content.
      await refuses("forbidden", () => svc.markUnavailable(worker, { commandId: cid("u"), taskId: task, first: 1, last: 2, reason: "x" }));
      await svc.markUnavailable(owner, { commandId: cid("u"), taskId: task, first: 1, last: 2, reason: "archived with the old checkout" });
      const after = (await svc.steps(auditor, task)).steps;
      assert.deepEqual(after.slice(0, 2), [{ seq: 1, unavailable: "archived with the old checkout" }, { seq: 2, unavailable: "archived with the old checkout" }]);
      await refuses("not_found", () => svc.payload(owner, task, 2));
      assert.match((await svc.explainLater(auditor, { commandId: cid("l"), taskId: task, seq: 1 })).explanation.choice, /unavailable/);
      await refuses("invalid_command", () => svc.markUnavailable(owner, { commandId: cid("u"), taskId: task, first: 1, last: 500, reason: "x" }));
    } finally { await world.close(); }
  });
}
