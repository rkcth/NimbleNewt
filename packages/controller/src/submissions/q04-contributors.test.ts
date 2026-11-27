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
import { CONTRIBUTORS, CONTRIBUTORS_KEPT, contributorChange, taskContributors } from "./contributors.js";
import { QaEvidenceService, SubmissionService, landingDirectorGate, type SubmissionBody } from "./index.js";

// Card Q04, clause 4: "a QA agent that commits a fix becomes a contributor and cannot approve it". A contributor of a task is every agent that submitted code on it (any version, whatever became of it)
// (`contributors.ts`; holding the task to review it is not a contribution, only the review policy's choice of reviewer also leaves the holder out). Its QA evidence is a self-check, never counted, and its approval of the task's code is refused (and, read later, does not count).

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
      assert.deepEqual(g1.reasons, ["no_evidence", "check_missing"], "a contributor's pass is not evidence, and the check it named is still owed");
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

      // 9. Holding the task is not a contribution (second review): a local reviewer reviews in an attempt of the task itself (the owner transfers the task to it, card Q01b), so its evidence is independent
      // and its approval counts. Only the review policy's choice of reviewer (`withHolder`) also leaves the holder out. Once the holder submits code, what it approved and passed before stops counting.
      const dee = await agent("dee", ["qa", "reviewer"]);
      const plant = async (kind: string, id: string, body: object): Promise<void> => {
        const found = await runner.get(kind, id);
        await runner.command("test.plant", { commandId: cid("plant"), actor: owner.id }, async () => ({ payload: { kind, id, n: cid("x") }, build: async () => ({ ref: { kind, id }, creates: found === undefined, changes: [found === undefined ? { type: "create" as const, ref: { kind, id }, body: body as JsonObject } : { type: "update" as const, ref: { kind, id }, expectedRevision: found.revision, body: body as JsonObject }], detail: {} }) }));
      };
      await plant("assignment", assignmentIdOf(other), { taskId: other, owner: { id: "dee" } });
      assert.equal((await evidence(dee, u1)).source, "independent", "the holder that submitted nothing checks independently");
      assert.equal((await taskContributors(runner, project, other)).has(dee.id), false);
      assert.equal((await taskContributors(runner, project, other, [], { withHolder: true })).has(dee.id), true, "the review policy's pick still leaves the holder out");
      await review(dee, other, u1, "approve");
      assert.equal((await subs.approvalOf(u1))?.approvedBy, dee.id, "the holder's review approval counts");
      roles.set(dee.id, ["author", "qa", "reviewer"]);
      await code(dee, other, 9);
      const after9 = await subs.approvalOf(u1);
      assert.equal(after9?.approved, false, "once the holder submits code, its earlier approval stops counting");
      assert.match(after9?.reason ?? "", CONTRIBUTED);
      assert.match(after9?.reason ?? "", /with none left, the owner adds a reviewer agent or drops review from the required checks/, "the owner is told its way out");
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
      const bound = (await QaEvidenceService.withEpoch(world.storage, projects.epoch, { rolesOf }, options).gateBound(owner, old)).reads;
      assert.ok(bound.some((r) => r.kind === "code-submission-index" && r.id === project), "with no record, a write relying on the gate is bound to the code index it read contributors from");
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
      const v2 = (await tiny.record(bob, { commandId: cid("code"), taskId: t2, kind: "code", role: "author", base: BASE, tree: tree(9), patchId: patch(9) })).id;
      assert.equal(((await runner.get(CONTRIBUTORS, t2))?.body as { complete?: boolean }).complete, false);
      await plantIndex([{ taskId: t2, id: old, at: body.submittedAt, by: ann.id }]);
      assert.equal((await taskContributors(runner, project, t2)).has(ann.id), true, "an incomplete record is read with the code index");
      const reads2 = (await qa.gateBound(owner, v2)).reads;
      assert.ok(reads2.some((r) => r.kind === "code-submission-index" && r.id === project) && reads2.some((r) => r.kind === CONTRIBUTORS && r.id === t2), "an incomplete record binds the code index as well");
      assert.ok(!(await qa.gateBound(owner, v)).reads.some((r) => r.kind === "code-submission-index"), "a complete record does not");
      // The code index is read for this task only: an entry of another task of the project does not make its agent a contributor here.
      const cy = await agent("cy", ["qa"]);
      await plantIndex([{ taskId: task, id: old, at: body.submittedAt, by: cy.id }]);
      assert.equal((await taskContributors(runner, project, t2)).has(cy.id), false, "scope is the task");
      // Submitters the caller already knows (the subject's own, a scan's) are always added, even for a task with no record and no index entry.
      const t3 = (await projects.createTask({ commandId: cid("t"), actor: owner.id, projectId: project, title: "T3" })).id;
      assert.deepEqual([...(await taskContributors(runner, project, t3, ["cy"]))], [cy.id], "named by bare ID or principal ID alike");
      // A project whose code index is first written over older code (here: no index, old code planted) is not marked as having every code's record: a new task of it is still seeded by a scan.
      const p2 = (await projects.createProject({ commandId: cid("p"), actor: owner.id, name: "P2" })).id;
      const p2task = (await projects.createTask({ commandId: cid("t"), actor: owner.id, projectId: p2, title: "Old" })).id;
      const old2 = derivedId("sbm", cid("old"));
      await runner.command("test.plant", { commandId: cid("plant"), actor: owner.id }, async () => ({ payload: { old2 }, build: async () => ({ ref: { kind: "submission", id: old2 }, creates: true, changes: [{ type: "create" as const, ref: { kind: "submission", id: old2 }, body: { ...body, projectId: p2, taskId: p2task } as unknown as JsonObject }], detail: {} }) }));
      const p2new = (await projects.createTask({ commandId: cid("t"), actor: owner.id, projectId: p2, title: "New" })).id;
      await principals.enroll(owner, { commandId: cid("e"), kind: "agent", name: "eve", grants: [{ action: "task.read", project: p2 }] });
      const eve = await principals.authenticate((await principals.issueCredential(owner, "agent:eve")).token);
      roles.set(eve.id, ["author"]);
      await subs.record(eve, { commandId: cid("code"), taskId: p2new, kind: "code", role: "author", base: BASE, tree: tree(10), patchId: patch(10) });
      assert.equal(((await runner.get("code-submission-index", p2))?.body as { contributorsRecorded?: boolean }).contributorsRecorded, undefined, "seeded over older code: not marked");
      // Second review: the seed is the task's own. The scan found Ann's old code of another task of P2 and left it out; the next new task is seeded from P2's complete index, again for its own task only.
      assert.deepEqual((await runner.get(CONTRIBUTORS, p2new))?.body, { taskId: p2new, ids: [eve.id], complete: true }, "a seed scan reads this task's code only");
      const p2third = (await projects.createTask({ commandId: cid("t"), actor: owner.id, projectId: p2, title: "Third" })).id;
      assert.equal(((await runner.get("code-submission-index", p2))?.body as { complete?: boolean }).complete, true);
      await subs.record(eve, { commandId: cid("code"), taskId: p2third, kind: "code", role: "author", base: BASE, tree: tree(11), patchId: patch(11) });
      assert.deepEqual((await runner.get(CONTRIBUTORS, p2third))?.body, { taskId: p2third, ids: [eve.id], complete: true }, "a seed from the index reads this task's entries only");
    } finally { await world.close(); }
  });

  test(`${backend.name}: a later contributor's earlier failure still fails the gate, only an agent holder counts, a director that contributed cannot sign off, and a project with its index from the start does not scan (card Q04 review)`, async () => {
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
      // A one-page, one-read scan and a code index of two entries: a scan would not reach the end, and the index soon stops covering the project.
      const subs = SubmissionService.withEpoch(world.storage, projects.epoch, rolesOf, { ...options, waitingScan: { pageSize: 1, reads: 1 }, codeIndexKept: 2 });
      const qa = QaEvidenceService.withEpoch(world.storage, projects.epoch, { rolesOf }, options);
      const runner = new CommandRunner(world.storage, projects.epoch, options);
      const bob = await agent("bob", ["author"]);
      const cal = await agent("cal", ["author", "qa", "reviewer", "director"]);
      const dan = await agent("dan", ["qa", "reviewer", "director"]);
      const code = async (by: Principal, t: string, k: number): Promise<string> => (await subs.record(by, { commandId: cid("code"), taskId: t, kind: "code", role: "author", base: BASE, tree: tree(k), patchId: patch(k) })).id;
      const evidence = (by: Principal, submissionId: string, result: "passed" | "failed") => qa.record(by, { commandId: cid("qae"), submissionId, criteriaRevision: 0, environment: "linux", observedAt: "2026-11-26T09:00:00.000Z", checks: [{ name: "unit", result }] });
      const signoff = (by: Principal, subject: string, decision: "approve" | "decline") => subs.record(by, { commandId: cid("so"), taskId: task, kind: "signoff", role: "director", subject, decision });

      // 1. Dan passes "unit" on Bob's v1, then Cal (independent then) finds it failing: the gate fails. Cal also signs v1 off as director.
      const v1 = await code(bob, task, 1);
      assert.equal(((await runner.get("code-submission-index", project))?.body as { contributorsRecorded?: boolean }).contributorsRecorded, true, "the project's first code writes the index with the mark");
      await evidence(dan, v1, "passed");
      const failing = await evidence(cal, v1, "failed");
      assert.equal(failing.source, "independent");
      assert.equal((await qa.gate(owner, v1)).verdict, "failed");
      await signoff(cal, v1, "approve");
      assert.equal((await subs.approvalOf(v1))?.director?.by, cal.id);

      // 2. Cal then submits code on the task. His pass would not count any more, but the failure he found still does: the gate of v1 stays failed (it does not fall back to Dan's older pass).
      await code(cal, task, 2);
      const g1 = await qa.gate(owner, v1);
      assert.equal(g1.verdict, "failed", "a later contributor's failure is not dropped");
      assert.ok(g1.reasons.includes("check_failed"), g1.reasons.join(","));
      assert.deepEqual(g1.byContributors, [failing.id]);
      assert.ok((await qa.gateBound(owner, v1)).reads.some((r) => r.kind === CONTRIBUTORS && r.id === task), "a write relying on the gate is bound to who contributed");
      // 3. His sign-off of v1, given before he contributed, does not count now (plain words), and a new approving sign-off is refused; a decline is still taken.
      const a1 = await subs.approvalOf(v1);
      assert.equal(a1?.director, undefined);
      assert.match(a1?.directorNotCounted?.reason ?? "", /already contributed code to this task, so it cannot sign it off/);
      assert.match(a1?.directorNotCounted?.reason ?? "", /with none left, the owner adds one or drops the director check from the required checks/, "the owner is told its way out");
      const view = await landingDirectorGate(subs)(v1);
      assert.equal(view?.signoff, undefined);
      assert.match(view?.notCounted ?? "", /cannot sign it off; another director has to/, "the landing gate's reader is told why");
      await refuses("forbidden", () => signoff(cal, v1, "approve"), /already contributed code to this task, so it cannot sign it off; another director has to/);
      await signoff(cal, v1, "decline");
      await signoff(dan, v1, "approve");
      assert.equal((await subs.approvalOf(v1))?.director?.by, dan.id, "a director that never contributed signs off as before");

      // 4. The index no longer covers the project (two entries kept), yet a new task's first code needs no scan: every code of the project wrote its task's record, so the record is complete.
      assert.equal(((await runner.get("code-submission-index", project))?.body as { complete?: boolean }).complete, true);
      const t2 = (await projects.createTask({ commandId: cid("t"), actor: owner.id, projectId: project, title: "T2" })).id;
      const t3 = (await projects.createTask({ commandId: cid("t"), actor: owner.id, projectId: project, title: "T3" })).id;
      await code(bob, t2, 3);
      await code(bob, t3, 4);
      const index = (await runner.get("code-submission-index", project))?.body as { complete?: boolean; contributorsRecorded?: boolean };
      assert.deepEqual([index.complete, index.contributorsRecorded], [false, true], "past its limit the index is incomplete but keeps the mark");
      const t4 = (await projects.createTask({ commandId: cid("t"), actor: owner.id, projectId: project, title: "T4" })).id;
      await code(bob, t4, 5);
      assert.deepEqual((await runner.get(CONTRIBUTORS, t4))?.body, { taskId: t4, ids: [bob.id], complete: true }, "no scan, and nothing missed");

      // 5. For the review policy's pick (`withHolder`), only an agent owner holds the task as an agent: a person or role owner with Dan's name is someone else; an agent owner (bare or principal ID) is Dan.
      const plant = async (body: object): Promise<void> => {
        const id = assignmentIdOf(t2);
        const found = await runner.get("assignment", id);
        await runner.command("test.plant", { commandId: cid("plant"), actor: owner.id }, async () => ({ payload: { id, n: cid("x") }, build: async () => ({ ref: { kind: "assignment", id }, creates: found === undefined, changes: [found === undefined ? { type: "create" as const, ref: { kind: "assignment", id }, body: body as JsonObject } : { type: "update" as const, ref: { kind: "assignment", id }, expectedRevision: found.revision, body: body as JsonObject }], detail: {} }) }));
      };
      for (const kind of ["person", "role", "team"]) {
        await plant({ taskId: t2, owner: { kind, id: "dan" } });
        assert.equal((await taskContributors(runner, project, t2, [], { withHolder: true })).has(dan.id), false, `a ${kind} owner named dan is not the agent dan`);
      }
      for (const id of ["dan", dan.id]) {
        await plant({ taskId: t2, owner: { kind: "agent", id } });
        assert.equal((await taskContributors(runner, project, t2, [], { withHolder: true })).has(dan.id), true, `an agent owner ${id}`);
        assert.equal((await taskContributors(runner, project, t2)).has(dan.id), false, `holding is not a contribution where approvals and evidence are counted (${id})`);
      }

      // 6. Two agents submit code on one new task at the same moment: the write that lost is built again, so neither is lost from the task's record.
      const t5 = (await projects.createTask({ commandId: cid("t"), actor: owner.id, projectId: project, title: "T5" })).id;
      await Promise.all([code(bob, t5, 6), code(cal, t5, 7)]);
      assert.deepEqual(((await runner.get(CONTRIBUTORS, t5))?.body as { ids?: string[] }).ids, [bob.id, cal.id].sort());
    } finally { await world.close(); }
  });

  test(`${backend.name}: a source that later contributed is not counted towards the sources a check needs, and an approval carried over by an unchanged patch stops counting when its reviewer contributes (card Q04 second review)`, async () => {
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
      const subs = SubmissionService.withEpoch(world.storage, projects.epoch, rolesOf, options);
      // The project's review policy asks for two independent sources per check.
      const qa = QaEvidenceService.withEpoch(world.storage, projects.epoch, { rolesOf, policy: async () => ({ requiredChecks: [], independentSources: 2 }) }, options);
      const bob = await agent("bob", ["author"]);
      const ann = await agent("ann", ["author", "qa", "reviewer"]);
      const cal = await agent("cal", ["qa", "reviewer"]);
      const dan = await agent("dan", ["qa", "reviewer"]);
      const code = async (by: Principal, k: number, p = k, base = BASE): Promise<string> => (await subs.record(by, { commandId: cid("code"), taskId: task, kind: "code", role: "author", base, tree: tree(k), patchId: patch(p) })).id;
      const evidence = (by: Principal, submissionId: string) => qa.record(by, { commandId: cid("qae"), submissionId, criteriaRevision: 0, environment: "linux", observedAt: "2026-11-26T09:00:00.000Z", checks: [{ name: "unit", result: "passed" }] });

      // 1. Cal and Ann (both independent then) pass "unit" on Bob's v1: two sources, the gate passes. Ann also approves v1.
      const v1 = await code(bob, 1);
      await evidence(cal, v1);
      await evidence(ann, v1);
      assert.equal((await qa.gate(owner, v1)).verdict, "passed");
      await subs.record(ann, { commandId: cid("rev"), taskId: task, kind: "review", role: "reviewer", subject: v1, verdict: "approve" });
      // 2. Bob rebases: the same patch on another base carries Ann's approval over (card Q02).
      const v1b = await code(bob, 2, 1, "d".repeat(40));
      assert.deepEqual([(await subs.approvalOf(v1b))?.approved, (await subs.approvalOf(v1b))?.carriedFrom], [true, v1]);
      // 3. Ann submits code on the task: her pass is no longer a source (one source left: fewer than two), and her approval, carried or not, no longer counts.
      await code(ann, 3);
      const g = await qa.gate(owner, v1);
      assert.equal(g.verdict, "failed");
      assert.ok(g.reasons.includes("fewer_sources"), g.reasons.join(","));
      assert.deepEqual(g.shortfalls, [{ check: "unit", sources: 1 }]);
      const carried = await subs.approvalOf(v1b);
      assert.equal(carried?.approved, false, "a carried approval by a later contributor does not count");
      assert.match(carried?.reason ?? "", CONTRIBUTED);
      // 4. Dan, who never contributed, adds the second source: the gate passes again.
      await evidence(dan, v1);
      assert.equal((await qa.gate(owner, v1)).verdict, "passed");
    } finally { await world.close(); }
  });
}

test("a task's record keeps at most CONTRIBUTORS_KEPT submitters: one more marks it incomplete (readers then add the code index), and an incomplete full record is left as it is (card Q04 review)", async () => {
  const ids = Array.from({ length: CONTRIBUTORS_KEPT }, (_, i) => `agent:a${String(i).padStart(3, "0")}`);
  const reader = (body: object | undefined) => ({ get: async () => (body === undefined ? undefined : { body, revision: 7 }) });
  const noSeed = async () => assert.fail("a stored record is never seeded again");
  const full = await contributorChange(reader({ taskId: "t", ids, complete: true }), "t", "agent:zed", noSeed);
  assert.equal(full.length, 1);
  const change = full[0] as unknown as { type: string; expectedRevision?: number; body: { ids: string[]; complete: boolean } };
  assert.deepEqual([change.type, change.expectedRevision, change.body.ids.length, change.body.ids.includes("agent:zed"), change.body.complete], ["update", 7, CONTRIBUTORS_KEPT, false, false]);
  assert.deepEqual(await contributorChange(reader({ taskId: "t", ids, complete: false }), "t", "agent:zed", noSeed), [], "already incomplete: nothing to write");
  assert.deepEqual(await contributorChange(reader({ taskId: "t", ids, complete: true }), "t", ids[3]!, noSeed), [], "a known submitter changes nothing");
  const seeded = await contributorChange(reader(undefined), "t", "zed", async () => ({ ids: ["agent:amy", "bo"], complete: true }));
  assert.deepEqual((seeded[0] as unknown as { type: string; body: object }).body, { taskId: "t", ids: ["agent:amy", "agent:bo", "agent:zed"], complete: true }, "a seed is stored as principal IDs");
});
