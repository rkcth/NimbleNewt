import assert from "node:assert/strict";
import { after, test } from "node:test";
import { DomainError, type DomainErrorCode } from "../domain/errors.js";
import { CommandRunner } from "../domain/runner.js";
import { ProjectService } from "../domain/service.js";
import { backends, stopServer } from "../domain/testing/backends.js";
import { TASK_ATTEMPTS_KIND } from "../dispatch/model.js";
import { PrincipalService, type Principal } from "../security/index.js";
import type { JsonObject } from "../storage/types.js";
import { dispatcherStage, stagedSubmit } from "../work-end/index.js";
import { CONTRIBUTORS, leftChangesBy, taskContributors } from "./contributors.js";
import { QaEvidenceService, SubmissionService } from "./index.js";

// Card Q04, the holder gap: the task's checkout belongs to the task, so an attempt starts from what the attempt before it left, and its submission stages all of it. The worker host reports which earlier
// attempts left changes (`leftBy` with the submit's staging); their agents become contributors of the task in the same write as the submission. A reviewer that changed nothing stays independent. A host that
// cannot say (no report, an incomplete one, an attempt the controller does not know) fails closed: the agent of the attempt before this one is added, and when even that cannot be found the work is not submitted.

after(stopServer);

const options = { clock: () => "2026-11-26T10:00:00.000Z", pause: async () => undefined };
let n = 0;
const cid = (label: string): string => `${label}-${n++}`;
const refuses = async (code: DomainErrorCode, run: () => Promise<unknown>, match?: RegExp): Promise<void> => {
  await assert.rejects(run, (error: unknown) => { assert.ok(error instanceof DomainError, String(error)); assert.equal(error.code, code, error.message); if (match) assert.match(error.message, match); return true; });
};
const BASE = "c".repeat(40);
const tree = (k: number): string => k.toString(16).repeat(40).slice(0, 40);
const patch = (k: number): string => (k + 5).toString(16).repeat(40).slice(0, 40);
const CONTRIBUTED = /already contributed code to this task, so it cannot approve it/;
const bare = (id: string): string => (id.startsWith("agent:") ? id.slice("agent:".length) : id);

async function setup(backend: (typeof backends)[number]) {
  const world = await backend.open();
  const projects = await ProjectService.open(world.storage, { holder: "c1", ...options });
  const principals = PrincipalService.withEpoch(world.storage, projects.epoch, options);
  const owner = await principals.authenticate((await principals.bootstrapOwner({ name: "rob" })).token);
  const project = (await projects.createProject({ commandId: cid("p"), actor: owner.id, name: "P" })).id;
  const task = (await projects.createTask({ commandId: cid("t"), actor: owner.id, projectId: project, title: "T" })).id;
  const other = (await projects.createTask({ commandId: cid("t"), actor: owner.id, projectId: project, title: "U" })).id;
  const roles = new Map<string, string[]>();
  const agent = async (nm: string, held: string[]): Promise<Principal> => {
    await principals.enroll(owner, { commandId: cid("e"), kind: "agent", name: nm, grants: [{ action: "task.read", project }] });
    const p = await principals.authenticate((await principals.issueCredential(owner, `agent:${nm}`)).token);
    roles.set(p.id, held);
    return p;
  };
  const rolesOf = async (id: string): Promise<readonly string[]> => roles.get(id) ?? [];
  const subs = SubmissionService.withEpoch(world.storage, projects.epoch, rolesOf, options);
  const qa = QaEvidenceService.withEpoch(world.storage, projects.epoch, { rolesOf }, options);
  const runner = new CommandRunner(world.storage, projects.epoch, options);
  const plant = async (kind: string, id: string, body: object): Promise<void> => {
    const found = await runner.get(kind, id);
    await runner.command("test.plant", { commandId: cid("plant"), actor: owner.id }, async () => ({ payload: { kind, id, n: cid("x") }, build: async () => ({ ref: { kind, id }, creates: found === undefined, changes: [found === undefined ? { type: "create" as const, ref: { kind, id }, body: body as JsonObject } : { type: "update" as const, ref: { kind, id }, expectedRevision: found.revision, body: body as JsonObject }], detail: {} }) }));
  };
  /** An attempt of a task as the assignment service records it (kind `attempt`), and the dispatcher's per-task list of claimed attempts (newest last). */
  const attempts: Record<string, string[]> = {};
  const attempt = async (id: string, t: string, who: Principal | { kind: string; id: string }, number: number, listed = true): Promise<void> => {
    const ownerOf = "kind" in who && who.kind !== "agent" ? { kind: who.kind, id: who.id } : { kind: "agent", id: bare(who.id) };
    await plant("attempt", id, { taskId: t, generation: 1, owner: ownerOf, number, state: "active", admittedBy: owner.id });
    if (listed) { attempts[t] = [...(attempts[t] ?? []), id]; await plant(TASK_ATTEMPTS_KIND, t, { taskId: t, attempts: attempts[t]! }); }
  };
  /** The controller's ending of `attemptId` by `by`, staging `k` with what the host reported (`leftBy`; `undefined`: the host did not say). */
  const end = async (by: Principal, t: string, attemptId: string, k: number, leftBy: { attempts: readonly string[]; complete: boolean } | undefined): Promise<string> => {
    const submit = stagedSubmit({ stage: async () => ({ base: BASE, tree: tree(k), patchId: patch(k), files: [`f${k}.ts`], ...(leftBy === undefined ? {} : { leftBy }) }), submissions: subs, principalOf: async () => by });
    return (await submit({ attemptId, taskId: t, projectId: project, agentId: bare(by.id), live: true, hostId: "h", generation: 1 } as never, BASE, cid("workend"))).submissionId;
  };
  const review = (by: Principal, t: string, subject: string, verdict: "approve" | "changes" | "reject") => subs.record(by, { commandId: cid("rev"), taskId: t, kind: "review", role: "reviewer", subject, verdict });
  const evidence = (by: Principal, submissionId: string) => qa.record(by, { commandId: cid("qae"), submissionId, criteriaRevision: 0, environment: "linux", observedAt: "2026-11-26T09:00:00.000Z", checks: [{ name: "unit", result: "passed" }] });
  const contributors = async (t: string) => [...(await taskContributors(runner, project, t))].sort();
  return { world, owner, project, task, other, agent, subs, qa, runner, attempt, end, review, evidence, contributors, plant };
}

for (const backend of backends) {
  test(`${backend.name}: an agent whose attempt left changes in the checkout becomes a contributor with the next submission: its earlier approval and QA pass stop counting, its later ones are refused or a self-check; a reviewer that changed nothing stays independent (card Q04)`, async () => {
    const s = await setup(backend);
    try {
      const ann = await s.agent("ann", ["author", "qa", "reviewer"]);
      const bob = await s.agent("bob", ["author"]);
      const cal = await s.agent("cal", ["qa", "reviewer"]);
      // Bob's first attempt submits v1; nothing was left before it. Ann (reviewer) approves and passes it: independent.
      await s.attempt("att-b1", s.task, bob, 1);
      const v1 = await s.end(bob, s.task, "att-b1", 1, { attempts: [], complete: true });
      assert.deepEqual(await s.contributors(s.task), [bob.id]);
      const early = await s.evidence(ann, v1);
      assert.equal(early.source, "independent");
      await s.review(ann, s.task, v1, "approve");
      assert.equal((await s.subs.approvalOf(v1))?.approved, true);
      // Ann holds the task for a review (her own attempt) and changes nothing; Bob's next attempt submits v2: the host names no one, Ann stays independent (the Q01b review flow).
      await s.attempt("att-a1", s.task, ann, 2);
      await s.attempt("att-b2", s.task, bob, 3);
      const v2 = await s.end(bob, s.task, "att-b2", 2, { attempts: [], complete: true });
      assert.deepEqual(await s.contributors(s.task), [bob.id], "a reviewer that changed nothing is not a contributor");
      assert.equal((await s.evidence(ann, v2)).source, "independent");
      await s.review(ann, s.task, v2, "approve");
      assert.equal((await s.subs.approvalOf(v2))?.approvedBy, ann.id);
      // Ann holds the task again and this time leaves an uncommitted edit; Bob's next attempt starts from it and submits v3, staging it. The host names Ann's attempt.
      await s.attempt("att-a2", s.task, ann, 4);
      await s.attempt("att-b3", s.task, bob, 5);
      const v3 = await s.end(bob, s.task, "att-b3", 3, { attempts: ["att-a2"], complete: true });
      assert.deepEqual(await s.contributors(s.task), [ann.id, bob.id].sort(), "Ann's attempt left changes that v3 staged");
      assert.deepEqual((await s.runner.get(CONTRIBUTORS, s.task))?.body, { taskId: s.task, ids: [ann.id, bob.id].sort(), complete: true }, "written in the same write as the submission");
      // Ann's QA pass on v3 is a self-check; her approval is refused, in the contributor's words.
      assert.equal((await s.evidence(ann, v3)).source, "self");
      await refuses("forbidden", () => s.review(ann, s.task, v3, "approve"), CONTRIBUTED);
      assert.equal((await s.subs.approvalOf(v3))?.approved, false);
      // What Ann approved and passed before stops counting when read.
      const a1 = await s.subs.approvalOf(v1);
      assert.equal(a1?.approved, false);
      assert.match(a1?.reason ?? "", CONTRIBUTED);
      assert.equal((await s.qa.gate(s.owner, v1)).verdict, "failed");
      // Cal never held the task: independent, may approve.
      assert.equal((await s.evidence(cal, v3)).source, "independent");
      await s.review(cal, s.task, v3, "approve");
      assert.equal((await s.subs.approvalOf(v3))?.approvedBy, cal.id);
      // The other task is unaffected.
      assert.deepEqual(await s.contributors(s.other), []);
    } finally { await s.world.close(); }
  });

  test(`${backend.name}: a host that cannot say who left changes fails closed: the agent of the attempt before is added; an attempt the controller does not know for the task counts as not known; when the attempt before cannot be found nothing is submitted; a person owner is never added (card Q04)`, async () => {
    const s = await setup(backend);
    try {
      const ann = await s.agent("ann", ["author", "reviewer"]);
      const bob = await s.agent("bob", ["author"]);
      const dee = await s.agent("dee", ["author"]);
      // A first attempt with no report: there is no attempt before it, nothing is added.
      await s.attempt("att-1", s.task, bob, 1);
      await s.end(bob, s.task, "att-1", 1, undefined);
      assert.deepEqual(await s.contributors(s.task), [bob.id]);
      // Ann's attempt, then Bob's with no report (a host that does not say, such as one older than this card): Ann's, the attempt before, is added.
      await s.attempt("att-2", s.task, ann, 2);
      await s.attempt("att-3", s.task, bob, 3);
      await s.end(bob, s.task, "att-3", 3, undefined);
      assert.deepEqual(await s.contributors(s.task), [ann.id, bob.id].sort());
      // An incomplete report adds the attempt before as well as the ones named.
      const t2 = s.other;
      await s.attempt("att-u1", t2, dee, 1);
      await s.attempt("att-u2", t2, ann, 2);
      await s.attempt("att-u3", t2, bob, 3);
      await s.end(bob, t2, "att-u3", 4, { attempts: ["att-u1"], complete: false });
      assert.deepEqual(await s.contributors(t2), [ann.id, bob.id, dee.id].sort());
      // Straight on the rule: an attempt of another task, or one the controller has no record of, is not known (the attempt before is added); a malformed report is not known.
      assert.deepEqual((await leftChangesBy(s.runner, t2, "att-u3", { attempts: ["att-2"], complete: true })).sort(), [ann.id], "att-2 is the other task's: the attempt before (Ann's) is added instead");
      assert.deepEqual((await leftChangesBy(s.runner, t2, "att-u3", { attempts: ["att-nowhere"], complete: true })).sort(), [ann.id]);
      assert.deepEqual((await leftChangesBy(s.runner, t2, "att-u3", { attempts: "att-u1", complete: true })).sort(), [ann.id]);
      assert.deepEqual((await leftChangesBy(s.runner, t2, "att-u3", { attempts: Array.from({ length: 65 }, (_, i) => `att-${i}`), complete: true })).sort(), [ann.id], "more than the bound is malformed");
      assert.deepEqual((await leftChangesBy(s.runner, t2, "att-u3", { attempts: ["att-u1", "att-u3"], complete: true })).sort(), [dee.id], "a complete report: the attempt itself is skipped, the attempt before is not added");
      // The attempt before cannot be found (not in the dispatcher's list): the work is not submitted.
      const t3 = s.task;
      await s.attempt("att-x", t3, bob, 9, false);
      await refuses("unavailable", () => s.end(bob, t3, "att-x", 5, undefined), /could not say which earlier attempts changed the task's checkout/);
      // A complete report needs no list: the same attempt submits when its host says.
      await s.end(bob, t3, "att-x", 6, { attempts: [], complete: true });
      // A person or role owner of an attempt is never added.
      await s.attempt("att-p", t3, { kind: "person", id: "rob" }, 10);
      await s.attempt("att-q", t3, dee, 11);
      assert.deepEqual(await leftChangesBy(s.runner, t3, "att-q", { attempts: ["att-p"], complete: true }), []);
      assert.deepEqual(await leftChangesBy(s.runner, t3, "att-q", undefined), [], "the attempt before is a person's");
    } finally { await s.world.close(); }
  });
}

test("the dispatcher's staging port carries the host's report on, and leaves it out when the host gave none (card Q04)", async () => {
  const staged = { base: BASE, tree: tree(1), patchId: patch(1), files: ["a.ts"] };
  const port = (leftBy?: { attempts: readonly string[]; complete: boolean }) => dispatcherStage(() => ({ dispatcher: { stageWork: async () => ({ ...staged, ...(leftBy === undefined ? {} : { leftBy }) }) }, principal: { id: "service:dispatcher", kind: "service" } as never }));
  const attempt = { attemptId: "att-1", taskId: "tsk-a", projectId: "prj-a", agentId: "bob" } as never;
  assert.deepEqual(await port({ attempts: ["att-0"], complete: true })(attempt), { ...staged, leftBy: { attempts: ["att-0"], complete: true } });
  assert.deepEqual(await port()(attempt), staged);
});
