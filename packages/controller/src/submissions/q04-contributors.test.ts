import assert from "node:assert/strict";
import { after, test } from "node:test";
import { assignmentIdOf } from "../domain/assignment-model.js";
import { DomainError, type DomainErrorCode } from "../domain/errors.js";
import { derivedId } from "../domain/ids.js";
import { CommandRunner } from "../domain/runner.js";
import { ProjectService } from "../domain/service.js";
import { backends, stopServer } from "../domain/testing/backends.js";
import { PrincipalService, type Principal } from "../security/index.js";
import type { JsonObject } from "../storage/types.js";
import { CONTRIBUTORS, taskContributors } from "./contributors.js";
import { QaEvidenceService, SubmissionService, type SubmissionBody } from "./index.js";

// Card Q04, clause 4: "a QA agent that commits a fix becomes a contributor and cannot approve it". A contributor of a task is every agent that submitted code on it (any version, whatever became of it) and the
// agent that holds it now (`contributors.ts`, the review policy's own definition). Its QA evidence is a self-check, never counted, and its approval of the task's code is refused (and, read later, does not count).

after(stopServer);

const options = { clock: () => "2026-11-26T10:00:00.000Z", pause: async () => undefined };
let n = 0;
const cid = (label: string): string => `${label}-${n++}`;
const refuses = async (code: DomainErrorCode, run: () => Promise<unknown>, match?: RegExp): Promise<void> => {
  await assert.rejects(run, (error: unknown) => { assert.ok(error instanceof DomainError, String(error)); assert.equal(error.code, code, error.message); if (match) assert.match(error.message, match); return true; });
};
const BASE = "c".repeat(40);
const tree = (k: number): string => k.toString(16).padStart(1, "0").repeat(40).slice(0, 40);
const patch = (k: number): string => (k + 5).toString(16).repeat(40).slice(0, 40);
const CONTRIBUTED = /already contributed code to this task, so it cannot approve it/;

for (const backend of backends) {
  test(`${backend.name}: an agent that submitted code on a task is a contributor: its QA evidence on a later version is a self-check and its approval is refused; other agents, the owner and other tasks are unaffected (card Q04)`, async () => {
    const world = await backend.open();
    try {
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
      const ann = await agent("ann", ["author", "qa", "reviewer"]);
      const bob = await agent("bob", ["author"]);
      const cal = await agent("cal", ["qa", "reviewer"]);
      const code = async (by: Principal, t: string, k: number): Promise<string> => (await subs.record(by, { commandId: cid("code"), taskId: t, kind: "code", role: "author", base: BASE, tree: tree(k), patchId: patch(k) })).id;
      const review = (by: Principal, t: string, subject: string, verdict: "approve" | "changes" | "reject") => subs.record(by, { commandId: cid("rev"), taskId: t, kind: "review", role: "reviewer", subject, verdict });
      const evidence = (by: Principal, submissionId: string) => qa.record(by, { commandId: cid("qae"), submissionId, criteriaRevision: 0, environment: "linux", observedAt: "2026-11-26T09:00:00.000Z", checks: [{ name: "unit", result: "passed" }] });

      // 1. Bob submits the first version; Ann, not yet a contributor, checks and approves it: independent, counted.
      const v1 = await code(bob, task, 1);
      const early = await evidence(ann, v1);
      assert.equal(early.source, "independent", "before contributing, Ann's evidence is independent");
      assert.equal((await qa.gate(owner, v1)).verdict, "passed");
      await review(ann, task, v1, "approve");
      assert.equal((await subs.approvalOf(v1))?.approved, true);

      // 2. Ann commits a fix on the task (her own version), which Cal rejects; Bob submits the next version, containing it.
      const v2 = await code(ann, task, 2);
      await review(cal, task, v2, "reject");
      const v3 = await code(bob, task, 3);
      assert.deepEqual([...(await taskContributors(runner, project, task))].sort(), [ann.id, bob.id].sort(), "both submitters, Ann's rejected version included");
      assert.deepEqual(((await runner.get(CONTRIBUTORS, task))?.body as { ids?: string[]; complete?: boolean }), { taskId: task, ids: [ann.id, bob.id].sort(), complete: true }, "one record per task, written with the code");

      // 3. Ann's QA pass on Bob's next version is a self-check: kept, never counted.
      const mine = await evidence(ann, v3);
      assert.equal(mine.source, "self");
      const g3 = await qa.gate(owner, v3);
      assert.equal(g3.verdict, "failed");
      assert.deepEqual(g3.reasons, ["no_evidence"]);
      // 4. Ann's approval of it is refused, in plain words; a request for changes is not an approval and is still taken.
      await refuses("forbidden", () => review(ann, task, v3, "approve"), CONTRIBUTED);
      assert.equal((await subs.approvalOf(v3))?.approved, false);

      // 5. Retroactive effect, decided: what was recorded stays as recorded, and the gate and the approval read who contributed NOW. Ann's evidence and approval on v1 were given before she contributed;
      // they keep their record (`independent`, the review), but no longer count for v1.
      assert.equal(((await qa.get(owner, early.id)) as { source?: string } | undefined)?.source, "independent", "the record is not rewritten");
      const g1 = await qa.gate(owner, v1);
      assert.equal(g1.verdict, "failed", "read at gate time: Ann is a contributor now");
      assert.deepEqual(g1.byContributors, [early.id], "and the gate says which evidence it left out");
      const a1 = await subs.approvalOf(v1);
      assert.equal(a1?.approved, false);
      assert.match(a1?.reason ?? "", CONTRIBUTED);

      // 6. Cal never contributed: still independent, still counted, and may approve.
      assert.equal((await evidence(cal, v3)).source, "independent");
      assert.equal((await qa.gate(owner, v3)).verdict, "passed");
      await review(cal, task, v3, "approve");
      assert.equal((await subs.approvalOf(v3))?.approvedBy, cal.id);
      // 7. The owner is unaffected: its evidence is independent and counts.
      const v4 = await code(bob, task, 4);
      assert.equal((await evidence(owner, v4)).source, "independent");
      assert.equal((await qa.gate(owner, v4)).verdict, "passed");
      // The author's own rule is unchanged (its own message), also when it holds the reviewer role.
      roles.set(bob.id, ["author", "reviewer"]);
      await refuses("forbidden", () => review(bob, task, v4, "approve"), /reviewer's own submission/);

      // 8. The scope is the task: Ann's evidence and approval on another task of the same project still count.
      const u1 = await code(bob, other, 5);
      assert.equal((await evidence(ann, u1)).source, "independent");
      assert.equal((await qa.gate(owner, u1)).verdict, "passed");
      await review(ann, other, u1, "approve");
      assert.equal((await subs.approvalOf(u1))?.approvedBy, ann.id);

      // 9. The agent holding the task now is a contributor (the review policy's definition), named by its bare ID as assignments do; once the task moved away it is not (it submitted nothing).
      const dee = await agent("dee", ["qa", "reviewer"]);
      const plant = async (kind: string, id: string, body: object): Promise<void> => {
        const found = await runner.get(kind, id);
        await runner.command("test.plant", { commandId: cid("plant"), actor: owner.id }, async () => ({ payload: { kind, id, n: cid("x") }, build: async () => ({ ref: { kind, id }, creates: found === undefined, changes: [found === undefined ? { type: "create" as const, ref: { kind, id }, body: body as JsonObject } : { type: "update" as const, ref: { kind, id }, expectedRevision: found.revision, body: body as JsonObject }], detail: {} }) }));
      };
      await plant("assignment", assignmentIdOf(other), { taskId: other, owner: { id: "dee" } });
      assert.equal((await evidence(dee, u1)).source, "self", "the holder's evidence is a self-check");
      await refuses("forbidden", () => review(dee, other, u1, "approve"), CONTRIBUTED);
      await plant("assignment", assignmentIdOf(other), { taskId: other, owner: { id: "bob" } });
      assert.equal((await evidence(dee, u1)).source, "independent", "no longer holding it and having submitted nothing, it is not a contributor");
    } finally { await world.close(); }
  });

  test(`${backend.name}: code submitted before the contributor record existed is found: the next code submission seeds the record by a bounded scan, and a missing record falls back to the project's code index (card Q04)`, async () => {
    const world = await backend.open();
    try {
      const projects = await ProjectService.open(world.storage, { holder: "c1", ...options });
      const principals = PrincipalService.withEpoch(world.storage, projects.epoch, options);
      const owner = await principals.authenticate((await principals.bootstrapOwner({ name: "rob" })).token);
      const project = (await projects.createProject({ commandId: cid("p"), actor: owner.id, name: "P" })).id;
      const task = (await projects.createTask({ commandId: cid("t"), actor: owner.id, projectId: project, title: "T" })).id;
      const roles = new Map<string, string[]>();
      const agent = async (nm: string, held: string[]): Promise<Principal> => {
        await principals.enroll(owner, { commandId: cid("e"), kind: "agent", name: nm, grants: [{ action: "task.read", project }] });
        const p = await principals.authenticate((await principals.issueCredential(owner, `agent:${nm}`)).token);
        roles.set(p.id, held);
        return p;
      };
      const rolesOf = async (id: string): Promise<readonly string[]> => roles.get(id) ?? [];
      const runner = new CommandRunner(world.storage, projects.epoch, options);
      const ann = await agent("ann", ["author", "qa", "reviewer"]);
      const bob = await agent("bob", ["author"]);
      // Ann's code as data from before card Q04 stored it: the submission only, no contributor record, no code index.
      const old = derivedId("sbm", cid("old"));
      const body: SubmissionBody = { taskId: task, projectId: project, kind: "code", role: "author", submittedBy: ann.id, submittedAt: "2026-11-25T09:00:00.000Z", makesCommit: false, base: BASE, tree: tree(7), patchId: patch(7), evidence: [] } as SubmissionBody;
      await runner.command("test.plant", { commandId: cid("plant"), actor: owner.id }, async () => ({ payload: { old }, build: async () => ({ ref: { kind: "submission", id: old }, creates: true, changes: [{ type: "create" as const, ref: { kind: "submission", id: old }, body: body as unknown as JsonObject }], detail: {} }) }));
      assert.equal(await runner.get(CONTRIBUTORS, task), undefined);
      // With the project's code index written (as Q01b's index has been since), the old code is found without a record. The index is absent here, so Ann is not yet known: the documented limit of a read.
      assert.equal((await taskContributors(runner, project, task)).has(ann.id), false);
      const plantIndex = async (entries: object[]): Promise<void> => {
        const found = await runner.get("code-submission-index", project);
        await runner.command("test.plant", { commandId: cid("plant"), actor: owner.id }, async () => ({ payload: { n: cid("i") }, build: async () => ({ ref: { kind: "code-submission-index", id: project }, creates: found === undefined, changes: [found === undefined ? { type: "create" as const, ref: { kind: "code-submission-index", id: project }, body: { complete: false, entries } as unknown as JsonObject } : { type: "update" as const, ref: { kind: "code-submission-index", id: project }, expectedRevision: found.revision, body: { complete: false, entries } as unknown as JsonObject }], detail: {} }) }));
      };
      await plantIndex([{ taskId: task, id: old, at: body.submittedAt, by: ann.id }]);
      assert.equal((await taskContributors(runner, project, task)).has(ann.id), true, "found through the project's code index");
      // An incomplete index that does not name Ann: Bob's next code submission seeds the task's record from one bounded scan of the table, which finds Ann's old code.
      await plantIndex([]);
      const subs = SubmissionService.withEpoch(world.storage, projects.epoch, rolesOf, options);
      const v = (await subs.record(bob, { commandId: cid("code"), taskId: task, kind: "code", role: "author", base: BASE, tree: tree(8), patchId: patch(8) })).id;
      assert.deepEqual((await runner.get(CONTRIBUTORS, task))?.body, { taskId: task, ids: [ann.id, bob.id].sort(), complete: true });
      await plantIndex([]);
      const qa = QaEvidenceService.withEpoch(world.storage, projects.epoch, { rolesOf }, options);
      assert.equal((await qa.record(ann, { commandId: cid("qae"), submissionId: v, criteriaRevision: 0, environment: "linux", observedAt: "2026-11-26T09:00:00.000Z", checks: [{ name: "unit", result: "passed" }] })).source, "self");
      await refuses("forbidden", () => subs.record(ann, { commandId: cid("rev"), taskId: task, kind: "review", role: "reviewer", subject: v, verdict: "approve" }), CONTRIBUTED);
      // A scan that cannot reach the end of the table marks the record incomplete, and readers then add the project's code index too.
      const t2 = (await projects.createTask({ commandId: cid("t"), actor: owner.id, projectId: project, title: "T2" })).id;
      const tiny = SubmissionService.withEpoch(world.storage, projects.epoch, rolesOf, { ...options, waitingScan: { pageSize: 1, reads: 1 } });
      await tiny.record(bob, { commandId: cid("code"), taskId: t2, kind: "code", role: "author", base: BASE, tree: tree(9), patchId: patch(9) });
      assert.equal(((await runner.get(CONTRIBUTORS, t2))?.body as { complete?: boolean }).complete, false);
      await plantIndex([{ taskId: t2, id: old, at: body.submittedAt, by: ann.id }]);
      assert.equal((await taskContributors(runner, project, t2)).has(ann.id), true, "an incomplete record is read with the code index");
      // The code index is read for this task only: an entry of another task of the project does not make its agent a contributor here.
      const cy = await agent("cy", ["qa"]);
      await plantIndex([{ taskId: task, id: old, at: body.submittedAt, by: cy.id }]);
      assert.equal((await taskContributors(runner, project, t2)).has(cy.id), false, "scope is the task");
      // Submitters the caller already knows (the subject's own, a scan's) are always added, even for a task with no record and no index entry.
      const t3 = (await projects.createTask({ commandId: cid("t"), actor: owner.id, projectId: project, title: "T3" })).id;
      assert.deepEqual([...(await taskContributors(runner, project, t3, ["cy"]))], [cy.id], "named by bare ID or principal ID alike");
    } finally { await world.close(); }
  });
}
