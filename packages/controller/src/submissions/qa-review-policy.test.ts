import assert from "node:assert/strict";
import { after, test } from "node:test";
import { DomainError } from "../domain/errors.js";
import { derivedId } from "../domain/ids.js";
import { assignmentIdOf } from "../domain/assignment-model.js";
import { CommandRunner } from "../domain/runner.js";
import { ProjectService } from "../domain/service.js";
import { backends, stopServer } from "../domain/testing/backends.js";
import { DeskService } from "../context/desks.js";
import { PrincipalService, type Principal } from "../security/index.js";
import type { JsonObject } from "../storage/types.js";
import { LandingGate } from "../landing/landing-gate.js";
import { landingQaGate } from "./qa-evidence.js";
import { QaEvidenceService, QaReviewService, inPolicyScope, withPolicyChecks } from "./index.js";

after(stopServer);

let n = 0;
const cid = (label: string): string => `${label}-${n++}`;
const T0 = Date.parse("2026-11-22T10:00:00.000Z");
const code = (e: unknown, c: string): boolean => e instanceof DomainError && e.code === c;

interface Notice { to: string; taskId: string; requestId: string; text: string }

async function world(backendOpen: () => Promise<{ storage: import("../storage/types.js").ControllerStorage; close(): Promise<void> }>) {
  const w = await backendOpen();
  let now = T0;
  const clock = (): string => new Date(now).toISOString();
  const options = { clock, pause: async () => undefined };
  const projects = await ProjectService.open(w.storage, { holder: "c1", ...options });
  const epoch = projects.epoch;
  const principals = PrincipalService.withEpoch(w.storage, epoch, options);
  const owner = await principals.authenticate((await principals.bootstrapOwner({ name: "rob" })).token);
  const project = (await projects.createProject({ commandId: cid("p"), actor: owner.id, name: "P" })).id;
  const other = (await projects.createProject({ commandId: cid("p"), actor: owner.id, name: "Q" })).id;
  const roles = new Map<string, string[]>();
  const agent = async (nm: string, held: string[], inProject: string = project): Promise<Principal> => {
    await principals.enroll(owner, { commandId: cid("e"), kind: "agent", name: nm, grants: [{ action: "task.read", project: inProject }, { action: "desk.read", project: inProject }] as never });
    const p = await principals.authenticate((await principals.issueCredential(owner, `agent:${nm}`)).token);
    roles.set(p.id, held);
    return p;
  };
  const runner = new CommandRunner(w.storage, epoch, options);
  const plant = async (kind: string, id: string, body: object): Promise<void> => {
    await runner.command("test.plant", { commandId: cid("plant"), actor: owner.id }, async () => ({ payload: { kind, id }, build: async () => ({ ref: { kind, id }, creates: true, changes: [{ type: "create" as const, ref: { kind, id }, body: body as JsonObject }], detail: {} }) }));
  };
  const desks = DeskService.withEpoch(w.storage, epoch, options);
  const qa = QaEvidenceService.withEpoch(w.storage, epoch, {
    rolesOf: async (id) => roles.get(id) ?? [],
    policy: async (projectId, taskId) => review.gateTerms(projectId, taskId),
    deskOrigins: async (reader, ids) => { const r = await desks.independence(reader, ids); return { origins: new Map(r.groups.flatMap((g) => g.records.map((id) => [id, g.origin] as const))), unavailable: r.unavailable }; },
  }, options);
  const notices: Notice[] = [];
  let pool: string[] = [];
  let failNotices = false;
  const review: QaReviewService = QaReviewService.withEpoch(w.storage, epoch, qa, {
    reviewers: async (_p, workerId) => pool.filter((x) => x !== workerId),
    notice: async (x) => { if (failNotices) throw new Error("down"); notices.push({ to: x.to, taskId: x.taskId, requestId: x.requestId, text: x.text }); },
  }, options);
  const mkTask = async (title: string, workClass: "P" | "PC" = "P", inProject = project): Promise<string> => {
    const id = (await projects.createTask({ commandId: cid("t"), actor: owner.id, projectId: inProject, title })).id;
    if (workClass === "PC") await plant("task-contract", id, { taskId: id, projectId: inProject, version: 1, changedBy: owner.id, acceptanceCriteria: [], priority: 5, budget: {}, workClass: "PC", requiredEvidence: [], checks: [], permissions: [], recovery: "native-continuation" });
    return id;
  };
  const submit = async (taskId: string, by: Principal, c: string, at = clock()): Promise<string> => {
    const id = derivedId("sbm", cid("sub"));
    await plant("submission", id, { taskId, projectId: project, kind: "code", role: "author", submittedBy: by.id, submittedAt: at, makesCommit: true, base: "a".repeat(40), tree: c.repeat(40), patchId: "c".repeat(40), evidence: [] });
    return id;
  };
  const evidence = (by: Principal, submissionId: string, checks: { name: string; result: string }[], extra: object = {}) =>
    qa.record(by, { commandId: cid("r"), submissionId, criteriaRevision: 0, environment: "linux", observedAt: new Date(now - 60_000).toISOString(), checks, ...extra } as never);
  return { w, owner, project, other, agent, plant, qa, review, notices, runner, mkTask, submit, evidence, desks,
    advance: (ms: number) => { now += ms; }, setPool: (x: string[]) => { pool = x; }, failNotices: (x: boolean) => { failNotices = x; }, clock };
}

for (const backend of backends) {
  test(`${backend.name}: the review policy is the owner's record: set, merged, read, scoped and never written by an agent (card Q02)`, async () => {
    const t = await world(backend.open);
    try {
      const { owner, project, other, review, agent } = t;
      const ann = await agent("ann", ["author"]);
      const far = await agent("far", ["reviewer"], other);
      const none = await review.get(owner, project);
      assert.equal(none.isDefault, true);
      assert.deepEqual(none.item.triggers, { onSubmission: false, periodicMinutes: null, onIncident: false });
      assert.equal(none.item.gatesCompletion, false);
      assert.equal(none.item.independentSources, 1);
      // Owner only to set; an agent that reads the project's tasks may read it; another project's agent finds no such project.
      await assert.rejects(() => review.set(ann, { commandId: cid("s"), projectId: project, onSubmission: true } as never), (e) => code(e, "forbidden"));
      assert.equal((await review.get(ann, project)).isDefault, true);
      await assert.rejects(() => review.get(far, project), (e) => code(e, "not_found"));
      await assert.rejects(() => review.get(owner, "proj-" + "a".repeat(20)), (e) => code(e, "not_found"));
      // Validation: every field is checked.
      const bad = (extra: Record<string, unknown>) => review.set(owner, { commandId: cid("s"), projectId: project, ...extra } as never);
      for (const extra of [{}, { periodicMinutes: 5 }, { periodicMinutes: 99_999 }, { periodicMinutes: 90.5 }, { workClasses: ["X"] }, { workClasses: ["P", "P"] }, { taskIds: ["nope"] }, { onSubmission: "yes" }, { independentSources: 0 }, { independentSources: 6 }, { requiredChecks: [""] }, { requiredChecks: new Array(21).fill("a").map((x, i) => x + i) }, { requiredChecks: ["key sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123456789"] }, { surprise: 1 }]) {
        await assert.rejects(() => bad(extra), (e) => code(e, "invalid_command"), JSON.stringify(extra));
      }
      const taskId = await t.mkTask("one");
      const foreign = await t.mkTask("elsewhere", "P", other);
      await assert.rejects(() => bad({ taskIds: [foreign] }), (e) => code(e, "invalid_command"), "a task of another project is not in scope");
      // Setting records when a trigger was switched on; fields left out stay.
      const first = await bad({ onSubmission: true, periodicMinutes: 60, requiredChecks: ["security"], workClasses: ["P"] });
      assert.equal(first.replayed, false);
      const a = (await review.get(owner, project)).item;
      assert.deepEqual([a.triggers, a.requiredChecks, a.scope.workClasses], [{ onSubmission: true, periodicMinutes: 60, onIncident: false }, ["security"], ["P"]]);
      assert.equal(a.since.submission, t.clock());
      t.advance(3_600_000);
      await bad({ gatesCompletion: true, independentSources: 2 });
      const b = (await review.get(owner, project)).item;
      assert.deepEqual([b.triggers, b.requiredChecks, b.gatesCompletion, b.independentSources], [a.triggers, ["security"], true, 2], "fields left out stay");
      assert.equal(b.since.submission, a.since.submission, "a trigger that stays on keeps its start");
      assert.equal(b.since.periodic, a.since.periodic);
      t.advance(3_600_000);
      await bad({ onSubmission: false, periodicMinutes: 30 });
      await bad({ onSubmission: true, onIncident: true });
      const c = (await review.get(owner, project)).item;
      assert.equal(c.since.submission, t.clock(), "a trigger switched off and on again starts again from now");
      assert.equal(c.since.incident, t.clock());
      assert.equal(c.since.periodic, t.clock(), "a changed interval starts again");
      // A repeat of the same command is recorded once.
      const same = { commandId: "same-" + n, projectId: project, requiredChecks: ["a", "b"] };
      const r1 = await review.set(owner, same as never);
      const r2 = await review.set(owner, same as never);
      assert.deepEqual([r1.replayed, r2.replayed, r1.revision], [false, true, r2.revision]);
      // Scope: pure and by the stored task.
      assert.equal(inPolicyScope({ scope: { workClasses: [], taskIds: [] } }, taskId, "PC"), true);
      assert.equal(inPolicyScope({ scope: { workClasses: ["P"], taskIds: [] } }, taskId, "PC"), false);
      assert.equal(inPolicyScope({ scope: { workClasses: [], taskIds: [taskId] } }, "tsk-other", "P"), false);
      await bad({ workClasses: ["PC"], gatesCompletion: true });
      assert.deepEqual(await review.landingChecks(project, taskId), [], "a task outside the scope adds nothing");
      const pc = await t.mkTask("production-change", "PC");
      assert.deepEqual(await review.landingChecks(project, pc), ["review", "qa"], "independent review gates completion for a task in scope");
      assert.deepEqual(await review.landingChecks(project, undefined), []);
      await bad({ gatesCompletion: false });
      assert.deepEqual(await review.landingChecks(project, pc), []);
      assert.equal((await review.landingChecks(other, pc)).length, 0, "another project's policy is not this one's");
    } finally { await t.w.close(); }
  });

  test(`${backend.name}: the policy adds required checks to the QA gate and counts independent evidence by original source (card Q02)`, async () => {
    const t = await world(backend.open);
    try {
      const { owner, project, review, qa, agent, plant, mkTask, submit, evidence } = t;
      const ann = await agent("ann", ["author"]);
      const bob = await agent("bob", ["qa"]);
      const cat = await agent("cat", ["reviewer"]);
      const dan = await agent("dan", ["qa"]);
      const task = await mkTask("Login");
      const sub = await submit(task, ann, "1");
      await evidence(bob, sub, [{ name: "unit", result: "passed" }]);
      assert.equal((await qa.gate(owner, sub)).verdict, "passed", "without a policy the one check passes");
      // A policy check is required in addition: until someone passes it the gate fails, naming it missing.
      await review.set(owner, { commandId: cid("s"), projectId: project, requiredChecks: ["security"] } as never);
      const g = await qa.gate(owner, sub);
      assert.deepEqual([g.verdict, g.required, g.counts.missing, g.reasons], ["failed", ["security"], 1, ["check_missing"]]);
      assert.deepEqual(g.checks.map((c) => [c.name, c.result]).sort(), [["security", "missing"], ["unit", "passed"]], "what the record named is still judged");
      await evidence(cat, sub, [{ name: "security", result: "passed" }]);
      assert.equal((await qa.gate(owner, sub)).verdict, "passed");
      // The same policy leaves a task outside its scope alone.
      await review.set(owner, { commandId: cid("s"), projectId: project, workClasses: ["PC"] } as never);
      assert.equal((await qa.gate(owner, sub)).required.length, 0, "a task of class P is outside a PC-only policy");
      await review.set(owner, { commandId: cid("s"), projectId: project, workClasses: [], independentSources: 2 } as never);
      // Two sources: bob and cat are two recorders, but only one of them passed `unit` and one `security`: each check has one source.
      const two = await qa.gate(owner, sub);
      assert.equal(two.verdict, "failed");
      assert.deepEqual(two.shortfalls, [{ check: "security", sources: 1 }, { check: "unit", sources: 1 }]);
      assert.ok(two.reasons.includes("fewer_sources"));
      assert.equal(two.sourcesNeeded, 2);
      // The same recorder twice is one source.
      await evidence(bob, sub, [{ name: "unit", result: "passed" }, { name: "security", result: "passed" }]);
      const one = await qa.gate(owner, sub);
      assert.equal(one.shortfalls?.length, 1, "bob twice is one source for unit; security now has bob and cat");
      assert.equal(one.shortfalls?.[0]?.check, "unit");
      // A second recorder passing it makes two.
      await evidence(dan, sub, [{ name: "unit", result: "passed" }]);
      const ok = await qa.gate(owner, sub);
      assert.deepEqual([ok.verdict, ok.shortfalls], ["passed", []]);
      // A failure by the newest record still fails whatever the count.
      await evidence(dan, sub, [{ name: "unit", result: "failed" }]);
      assert.deepEqual([(await qa.gate(owner, sub)).verdict, (await qa.gate(owner, sub)).reasons.includes("check_failed")], ["failed", true]);

      // A copy and its original are one source: eve copies bob's desk record and cites the copy; bob cites the original.
      const sub2 = await submit(await mkTask("Search"), ann, "2");
      const original = "dsk-" + "a".repeat(20), copy = "dsk-" + "b".repeat(20), unrelated = "dsk-" + "c".repeat(20);
      const eve = await agent("eve", ["qa"]);
      const desk = (owner_: string, extra: object = {}) => ({ owner: owner_, projectId: project, kind: "note", title: "findings", body: "unit passes", status: "accepted", visibility: "shared", ...extra });
      await plant("desk-record", original, desk(bob.id));
      await plant("desk-record", copy, desk(eve.id, { sources: [original], copiedFrom: original, origin: { recordId: original, owner: bob.id, projectId: project } }));
      await plant("desk-record", unrelated, desk(eve.id));
      await review.set(owner, { commandId: cid("s"), projectId: project, requiredChecks: [], independentSources: 2 } as never);
      await evidence(bob, sub2, [{ name: "unit", result: "passed" }], { sources: [original] });
      await evidence(eve, sub2, [{ name: "unit", result: "passed" }], { sources: [copy] });
      const copies = await qa.gate(owner, sub2);
      assert.deepEqual([copies.verdict, copies.shortfalls], ["failed", [{ check: "unit", sources: 1 }]], "a copy and its original are one source");
      // eve's second record cites another note of her own: one recorder, still one source.
      await evidence(eve, sub2, [{ name: "unit", result: "passed" }], { sources: [unrelated] });
      assert.equal((await qa.gate(owner, sub2)).verdict, "failed", "eve's two records are one recorder");
      // fay cites eve's note: the same original as eve's records, so still one source.
      const fay = await agent("fay", ["qa"]);
      await evidence(fay, sub2, [{ name: "unit", result: "passed" }], { sources: [unrelated] });
      assert.equal((await qa.gate(owner, sub2)).verdict, "failed", "citing the same original joins the source");
      // fay's own check, resting on nothing cited, is a second source.
      await evidence(fay, sub2, [{ name: "unit", result: "passed" }]);
      const fine = await qa.gate(owner, sub2);
      assert.equal(fine.verdict, "failed", "fay's records are all one recorder, joined to eve's original through the cited note");
      const gus = await agent("gus", ["qa"]);
      await evidence(gus, sub2, [{ name: "unit", result: "passed" }]);
      assert.equal((await qa.gate(owner, sub2)).verdict, "passed", "gus rests on nothing the others cite: two independent sources");
      // A cited record must exist and be readable by the recorder; at most ten.
      await assert.rejects(() => evidence(gus, sub2, [{ name: "unit", result: "passed" }], { sources: ["dsk-" + "z".repeat(20)] }), (e) => code(e, "invalid_command"));
      await assert.rejects(() => evidence(gus, sub2, [{ name: "unit", result: "passed" }], { sources: ["nope"] }), (e) => code(e, "invalid_command"));
    } finally { await t.w.close(); }
  });
}

for (const backend of backends) {
  test(`${backend.name}: the scheduler creates reviews on submission, periodically and on incident, for agents that did not work on the task, and leaves the contributor's running attempt untouched (card Q02, Q04)`, async () => {
    const t = await world(backend.open);
    try {
      const { owner, project, review, qa, agent, plant, mkTask, submit, evidence, notices, runner, w } = t;
      const ann = await agent("ann", ["author"]);
      const bob = await agent("bob", ["reviewer"]);
      const cat = await agent("cat", ["reviewer"]);
      t.setPool([bob.id, cat.id, ann.id]);
      const task = await mkTask("Login");
      // Ann holds the task and has a RUNNING attempt; she submitted code before the policy existed.
      const asg = assignmentIdOf(task);
      await plant("assignment", asg, { taskId: task, generation: 1, state: "active", owner: { kind: "agent", id: ann.id }, activeAttemptId: "att-live", attempts: 1 });
      await plant("attempt", "att-live", { taskId: task, owner: { kind: "agent", id: ann.id }, state: "running", generation: 1 });
      const old = await submit(task, ann, "1");
      const revisions = async (): Promise<Record<string, number | undefined>> => ({
        asg: (await runner.get("assignment", asg))?.revision, att: (await runner.get("attempt", "att-live"))?.revision, task: (await runner.get("task", task))?.revision,
      });
      const before = await revisions();
      // No policy: nothing happens.
      assert.deepEqual(await review.sweep(), { projects: 0, created: 0, assigned: 0, settled: 0, superseded: 0, unassigned: 0, errors: 0 });
      t.advance(60_000);
      await review.set(owner, { commandId: cid("s"), projectId: project, onSubmission: true } as never);
      // The backlog is not reviewed backwards.
      assert.equal((await review.sweep()).created, 0, "code submitted before the trigger was switched on is not reviewed");
      t.advance(60_000);
      const fresh = await submit(task, ann, "2");
      const first = await review.sweep();
      assert.deepEqual([first.created, first.errors], [1, 0]);
      const list = await review.requests(owner, project);
      assert.deepEqual(list.items.map((r) => [r.taskId, r.submissionId, r.trigger, r.assignee, r.state]), [[task, fresh, "submission", bob.id, "open"]], "the review goes to a reviewer that did not work on the task, not to ann");
      // Only the reviewer was told; the contributor was not messaged, her attempt, her assignment and the task were not touched.
      assert.deepEqual(notices.map((x) => x.to), [bob.id]);
      assert.deepEqual(await revisions(), before, "the contributor's running attempt keeps running: nothing about it was written");
      assert.equal(((await runner.get("attempt", "att-live"))?.body as { state: string }).state, "running");
      // Repeating the round makes nothing again, tells nobody again.
      t.advance(1000);
      assert.equal((await review.sweep()).created, 0);
      assert.equal(notices.length, 1);
      // A reader sees only its own: bob his, cat none; the owner all.
      assert.equal((await review.requests(bob, project)).total, 1);
      assert.equal((await review.requests(cat, project)).total, 0);
      assert.equal((await review.requests(owner, project, { limit: 1, after: 1 })).items.length, 0);

      // Evidence by an independent agent settles it.
      await evidence(cat, fresh, [{ name: "unit", result: "passed" }]);
      const settled = await review.sweep();
      assert.equal(settled.settled, 1);
      assert.equal((await review.requests(owner, project)).total, 0);
      const done = (await runner.get("qa-review-request", list.items[0]!.id))?.body as { state: string; settledBy: string };
      assert.equal(done.state, "done");
      assert.match(done.settledBy, /^qae-/);

      // A newer code submission replaces an open review: the old one is superseded and the new one is asked for.
      t.advance(60_000);
      const s3 = await submit(task, ann, "3");
      await review.sweep();
      assert.equal((await review.requests(owner, project)).items[0]?.submissionId, s3);
      t.advance(60_000);
      const s4 = await submit(task, ann, "4");
      const sup = await review.sweep();
      assert.deepEqual([sup.superseded, sup.created], [1, 1]);
      assert.deepEqual((await review.requests(owner, project)).items.map((r) => r.submissionId), [s4]);
      assert.deepEqual(await revisions(), before, "still untouched after every round");

      // Periodic: every 60 minutes the newest code of each unfinished task in scope is looked at again, unless a review of it is already owed.
      await review.set(owner, { commandId: cid("s"), projectId: project, onSubmission: false, periodicMinutes: 60 } as never);
      t.advance(3_600_000);
      const p1 = await review.sweep();
      assert.equal(p1.created, 0, "s4's review is still open: it is not asked for twice");
      await evidence(bob, s4, [{ name: "unit", result: "passed" }]);
      assert.equal((await review.sweep()).settled, 1);
      t.advance(3_600_000);
      assert.equal((await review.sweep()).created, 1, "a new period asks for a new look at the newest code");
      const periodic = (await review.requests(owner, project)).items[0]!;
      assert.deepEqual([periodic.trigger, periodic.submissionId], ["periodic", s4]);
      assert.equal((await review.sweep()).created, 0, "the same period makes no second request");
      await evidence(cat, s4, [{ name: "unit", result: "passed" }]);
      await review.sweep();
      void qa;

      // Incident: an incident opened after the trigger was switched on starts a review of the newest code of tasks in scope; an older or resolved one does not.
      await review.set(owner, { commandId: cid("s"), projectId: project, periodicMinutes: null, onIncident: true } as never);
      const inc = (id: string, firstAt: string, state: string, projectId = project) => plant("responsibility-incident", id, { responsibilityId: "rsp-x", projectId, signature: id, state, count: 1, firstAt, lastAt: firstAt, lastSummary: "x", worst: "failed" });
      await inc("rinc-old", new Date(T0).toISOString(), "open");
      await inc("rinc-resolved", t.clock(), "resolved");
      await inc("rinc-elsewhere", t.clock(), "open", t.other);
      t.advance(1000);
      assert.equal((await review.sweep()).created, 0, "no new incident yet");
      t.advance(1000);
      await inc("rinc-new", t.clock(), "open");
      const before2 = await revisions();
      const incSweep = await review.sweep();
      assert.equal(incSweep.created, 1);
      const byIncident = (await review.requests(owner, project)).items.find((r) => r.trigger === "incident")!;
      assert.deepEqual([byIncident.cause, byIncident.submissionId], ["rinc-new", s4]);
      assert.deepEqual(await revisions(), before2, "an incident review never touches the contributor's attempt");
      void w; void old;
    } finally { await t.w.close(); }
  });

  test(`${backend.name}: with nobody eligible the owner is told once, a reviewer who appears takes it, scope and assignment rules hold, and notices are repeated until delivered (card Q02)`, async () => {
    const t = await world(backend.open);
    try {
      const { owner, project, review, agent, mkTask, submit, notices, runner } = t;
      const ann = await agent("ann", ["author"]);
      const bob = await agent("bob", ["reviewer"]);
      const ben = await agent("ben", ["author"]);
      t.setPool([ann.id]);
      await review.set(owner, { commandId: cid("s"), projectId: project, onSubmission: true, workClasses: ["P"] } as never);
      t.advance(1000);
      const inScope = await mkTask("In scope");
      const production = await mkTask("Production change", "PC");
      const a = await submit(inScope, ann, "1");
      await submit(production, ann, "2");
      const r = await review.sweep();
      assert.deepEqual([r.created, r.unassigned], [1, 1], "the PC task is outside the policy's scope; the P task has no eligible reviewer (only its own author)");
      assert.deepEqual(notices.map((x) => x.to), ["owner"]);
      await review.sweep();
      assert.equal(notices.length, 1, "the owner is told once");
      // The pool grows: a reviewer who did not work on it takes the waiting request and is told.
      t.setPool([ann.id, bob.id]);
      const r2 = await review.sweep();
      assert.equal(r2.assigned, 1);
      assert.deepEqual(notices.map((x) => x.to), ["owner", bob.id]);
      assert.equal((await review.requests(owner, project)).items[0]?.assignee, bob.id);
      // The assignee later becomes unavailable: it moves to the next eligible reviewer, never to a contributor.
      const cy = await agent("cy", ["reviewer"]);
      t.setPool([ann.id, cy.id]);
      await review.sweep();
      assert.equal((await review.requests(owner, project)).items[0]?.assignee, cy.id);
      assert.equal(notices.at(-1)?.to, cy.id);
      // A task assignee that did not submit is not eligible either.
      await t.plant("assignment", assignmentIdOf(inScope), { taskId: inScope, generation: 1, state: "active", owner: { kind: "agent", id: cy.id }, attempts: 1 });
      t.setPool([cy.id]);
      await review.sweep();
      assert.equal((await review.requests(owner, project)).items[0]?.assignee, undefined, "cy now holds the task and cannot review it");
      void ben;

      // Notices are repeated until they go through: a failing notice leaves the request unnoticed, the next round tells.
      t.failNotices(true);
      t.advance(1000);
      const task3 = await mkTask("Third");
      t.setPool([bob.id, cy.id]);
      await submit(task3, ann, "3");
      await review.sweep();
      const third = (await review.requests(owner, project)).items.find((x) => x.taskId === task3)!;
      assert.equal(third.noticeAt, undefined);
      const count = notices.length;
      t.failNotices(false);
      await review.sweep();
      assert.equal(notices.length > count, true);
      assert.equal((await runner.get("qa-review-request", third.id))?.body !== undefined, true);
      assert.notEqual(((await runner.get("qa-review-request", third.id))?.body as { noticeAt?: string }).noticeAt, undefined);
      void a;

      // Paging by count.
      const page1 = await review.requests(owner, project, { limit: 1 });
      assert.equal(page1.items.length, 1);
      assert.equal(page1.next, 1);
      const page2 = await review.requests(owner, project, { limit: 1, after: page1.next! });
      assert.equal(page2.items.length, 1);
      assert.notEqual(page2.items[0]!.id, page1.items[0]!.id);
      await assert.rejects(() => review.requests(owner, project, { after: -1 }), (e) => code(e, "invalid_command"));
      await assert.rejects(() => review.requests(owner, project, { limit: 0 }), (e) => code(e, "invalid_command"));
    } finally { await t.w.close(); }
  });
}

for (const backend of backends) {
  test(`${backend.name}: when the policy says independent review gates completion, a landing of a task in scope needs the qa and review checks, and one outside it does not (card Q02, P09)`, async () => {
    const t = await world(backend.open);
    try {
      const { owner, project, review, qa, agent, mkTask, submit, evidence } = t;
      const ann = await agent("ann", ["author"]);
      const bob = await agent("bob", ["qa"]);
      const inScope = await mkTask("Production change", "PC");
      const outside = await mkTask("Small fix", "P");
      const sIn = await submit(inScope, ann, "1");
      const sOut = await submit(outside, ann, "2");
      const approval = (taskId: string) => ({ taskId, base: "a".repeat(40), tree: "1".repeat(40), patchId: "c".repeat(40), approved: true, approvedBy: "agent:rev", newest: "approve" as const, submittedBy: ann.id });
      let projectChecks: ("tests" | "review" | "qa")[] = [];
      const gate = new LandingGate({
        requiredChecks: async (projectId, taskId) => withPolicyChecks(projectChecks, taskId === undefined ? [] : await review.landingChecks(projectId, taskId)),
        tests: async () => undefined,
        approvalOf: async (id) => approval(id === sIn ? inScope : outside),
        qaGate: async (id) => landingQaGate(qa)(id),
        now: () => t.clock(),
      });
      const landing = (taskId: string, submissionId: string) => gate.evaluate({ taskId, projectId: project, submissionId, host: undefined });
      // No policy: the project requires nothing, so nothing is gated.
      assert.deepEqual([(await landing(inScope, sIn)).required, (await landing(inScope, sIn)).passed], [[], true]);
      await review.set(owner, { commandId: cid("s"), projectId: project, workClasses: ["PC"], gatesCompletion: true } as never);
      const gated = await landing(inScope, sIn);
      assert.deepEqual(gated.required, ["review", "qa"], "independent review gates completion for a task in scope");
      assert.equal(gated.passed, false, "no independent QA evidence yet: the landing may not go ahead");
      assert.equal(gated.results.find((r) => r.check === "qa")?.result, "not_run");
      assert.deepEqual((await landing(outside, sOut)).required, [], "a task outside the scope is not gated by the policy");
      // The project's own checks stay and are not repeated.
      projectChecks = ["tests", "qa"];
      assert.deepEqual((await landing(inScope, sIn)).required, ["tests", "review", "qa"]);
      assert.deepEqual((await landing(outside, sOut)).required, ["tests", "qa"]);
      // Turning it off removes what it added.
      await review.set(owner, { commandId: cid("s"), projectId: project, gatesCompletion: false } as never);
      assert.deepEqual((await landing(inScope, sIn)).required, ["tests", "qa"]);
      void evidence; void bob;
    } finally { await t.w.close(); }
  });
}

for (const backend of backends) {
  test(`${backend.name}: review of the review policy: the dispatcher's round is throttled, one sweep serves several projects, a contributor's own evidence does not close the review, a cancelled task's review is closed, a cited record outside the recorder's reach is refused, and a check the policy adds mid-landing refuses it (card Q02)`, async () => {
    const t = await world(backend.open);
    try {
      const { owner, project, other, review, runner, agent, mkTask, submit, evidence, plant } = t;
      const ann = await agent("ann", ["author"]);
      const ben = await agent("ben", ["author", "qa"]);
      const bob = await agent("bob", ["reviewer"]);
      const cat = await agent("cat", ["reviewer"], other);
      t.setPool([bob.id, cat.id]);
      await review.set(owner, { commandId: cid("s"), projectId: project, onSubmission: true } as never);
      await review.set(owner, { commandId: cid("s"), projectId: other, onSubmission: true } as never);
      t.advance(1000);
      // Two projects with policies: one round makes the review of each.
      const shared = await mkTask("Shared");
      const s1 = await submit(shared, ben, "1");
      t.advance(1000);
      const s2 = await submit(shared, ann, "2");
      const foreignTask = await mkTask("Elsewhere", "P", other);
      await plant("submission", derivedId("sbm", cid("sub")), { taskId: foreignTask, projectId: other, kind: "code", role: "author", submittedBy: ann.id, submittedAt: t.clock(), makesCommit: true, base: "a".repeat(40), tree: "9".repeat(40), patchId: "c".repeat(40), evidence: [] });
      const both = await review.sweep({ throttled: true });
      assert.deepEqual([both.projects, both.created, both.errors], [2, 2, 0]);
      assert.equal((await review.requests(owner, other)).total, 1, "the other project's review was made in the same round");
      // The dispatcher's round runs at most once a minute; the owner's own sweep always runs.
      assert.equal((await review.sweep({ throttled: true })).skipped, true);
      t.advance(59_000);
      assert.equal((await review.sweep({ throttled: true })).skipped, true);
      t.advance(1000);
      assert.equal((await review.sweep({ throttled: true })).skipped, undefined);
      assert.equal((await review.sweep()).skipped, undefined);
      // Ben submitted earlier code of the task: his evidence on ann's code counts for the QA gate but is not the independent review the policy asked for.
      void s1;
      await evidence(ben, s2, [{ name: "unit", result: "passed" }]);
      assert.equal((await review.sweep()).settled, 0, "a contributor's evidence leaves the review open");
      const holder = await agent("hal", ["qa"]);
      await plant("assignment", assignmentIdOf(shared), { taskId: shared, generation: 1, state: "active", owner: { kind: "agent", id: holder.id }, attempts: 1 });
      await evidence(holder, s2, [{ name: "unit", result: "passed" }]);
      assert.equal((await review.sweep()).settled, 0, "the agent that holds the task cannot close it either");
      await evidence(bob, s2, [{ name: "unit", result: "passed" }]);
      assert.equal((await review.sweep()).settled, 1, "the reviewer's evidence closes it");
      // A cancelled task's open review is closed and nobody is asked again.
      t.advance(1000);
      const doomed = await mkTask("Doomed");
      await submit(doomed, ann, "3");
      await review.sweep();
      const open = (await review.requests(owner, project)).items.find((r) => r.taskId === doomed)!;
      assert.ok(open !== undefined);
      const found = await runner.get("task", doomed);
      await runner.command("test.cancel", { commandId: cid("cancel"), actor: owner.id }, async () => ({ payload: { doomed }, build: async () => ({ ref: { kind: "task", id: doomed }, creates: false, changes: [{ type: "update" as const, ref: { kind: "task", id: doomed }, expectedRevision: found!.revision, body: { ...(found!.body as object), state: "cancelled" } as JsonObject }], detail: {} }) }));
      const closed = await review.sweep();
      assert.equal(closed.superseded, 1);
      assert.equal(closed.created, 0, "a cancelled task gets no new review");
      assert.deepEqual([((await runner.get("qa-review-request", open.id))?.body as { state: string; settledBy: string }).state, ((await runner.get("qa-review-request", open.id))?.body as { settledBy: string }).settledBy], ["superseded", "cancelled"]);
      // A cited desk record in a project the recorder cannot read is refused, whatever it holds.
      const outside = "dsk-" + "d".repeat(20);
      await plant("desk-record", outside, { owner: cat.id, projectId: other, kind: "note", title: "x", body: "y", status: "accepted", visibility: "shared" });
      await assert.rejects(() => evidence(bob, s2, [{ name: "unit", result: "passed" }], { sources: [outside] }), (e) => code(e, "invalid_command"), "a record of another project is not one bob can read");
    } finally { await t.w.close(); }
  });

  test(`${backend.name}: the landing's recheck refuses a landing when the review policy started gating the task after the first judgement, and skips the checks it dropped (card Q02, P09)`, async () => {
    const t = await world(backend.open);
    try {
      const { owner, project, review, qa, agent, mkTask, submit } = t;
      const ann = await agent("ann", ["author"]);
      const task = await mkTask("Production change", "PC");
      const sub = await submit(task, ann, "1");
      const gate = new LandingGate({
        requiredChecks: async (projectId, taskId) => withPolicyChecks(["tests"], taskId === undefined ? [] : await review.landingChecks(projectId, taskId)),
        tests: async () => undefined,
        approvalOf: async () => ({ taskId: task, base: "a".repeat(40), tree: "1".repeat(40), patchId: "c".repeat(40), approved: true, approvedBy: "agent:rev", newest: "approve" as const, submittedBy: ann.id }),
        qaGate: async (id) => landingQaGate(qa)(id),
        now: () => t.clock(),
      });
      const host = { landingChecks: async () => ({ checkout: true, change: { base: "a".repeat(40), head: "f".repeat(40), tree: "1".repeat(40), patchId: "c".repeat(40) }, checks: [], reviewedPatchId: "c".repeat(40) }) } as never;
      const first = await gate.evaluate({ taskId: task, projectId: project, submissionId: sub, host });
      assert.deepEqual(first.required, ["tests"]);
      await review.set(owner, { commandId: cid("s"), projectId: project, gatesCompletion: true } as never);
      const again = await gate.recheck(first);
      assert.deepEqual(again.added, ["review", "qa"], "a check the policy added since the first judgement refuses the landing");
      const gated = await gate.evaluate({ taskId: task, projectId: project, submissionId: sub, host });
      assert.deepEqual(gated.required, ["tests", "review", "qa"]);
      await review.set(owner, { commandId: cid("s"), projectId: project, gatesCompletion: false } as never);
      const dropped = await gate.recheck(gated);
      assert.equal(dropped.added, undefined, "a check the policy no longer adds is not read again");
    } finally { await t.w.close(); }
  });
}
