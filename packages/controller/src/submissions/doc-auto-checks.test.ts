import assert from "node:assert/strict";
import { after, test } from "node:test";
import { AssignmentService } from "../domain/assignments.js";
import { assignmentIdOf } from "../domain/assignment-model.js";
import { DomainError, type DomainErrorCode } from "../domain/errors.js";
import { derivedId } from "../domain/ids.js";
import { CommandRunner } from "../domain/runner.js";
import { ProjectService } from "../domain/service.js";
import { backends, stopServer } from "../domain/testing/backends.js";
import { PrincipalService, type Principal } from "../security/index.js";
import type { JsonObject } from "../storage/types.js";
import { DOC_AUTO_PRINCIPAL, DocObligationService, QaEvidenceService, releaseDocsCommandId, type DocObligationBody } from "./index.js";

after(stopServer);

const options = { clock: () => "2026-11-20T10:00:00.000Z", pause: async () => undefined };
let n = 0;
const cid = (label: string): string => `${label}-${n++}`;
const refuses = async (code: DomainErrorCode, run: () => Promise<unknown>, match?: RegExp): Promise<void> => {
  await assert.rejects(run, (error: unknown) => { assert.ok(error instanceof DomainError, String(error)); assert.equal(error.code, code, error.message); if (match) assert.match(error.message, match); return true; });
};
const treeA = "a".repeat(40);
const treeB = "b".repeat(40);

for (const backend of backends) {
  test(`${backend.name}: recorded and invalidated QA evidence checks the documents by itself, and a verification is bound to the QA records its gates were read from (card Q03, next slice)`, async () => {
    const world = await backend.open();
    try {
      const projects = await ProjectService.open(world.storage, { holder: "c1", ...options });
      const assignments = AssignmentService.withEpoch(world.storage, projects.epoch, projects, options);
      const principals = PrincipalService.withEpoch(world.storage, projects.epoch, options);
      const owner = await principals.authenticate((await principals.bootstrapOwner({ name: "rob" })).token);
      const project = (await projects.createProject({ commandId: cid("p"), actor: owner.id, name: "P" })).id;
      const login = (await projects.createTask({ commandId: cid("t"), actor: owner.id, projectId: project, title: "Login" })).id;
      const search = (await projects.createTask({ commandId: cid("t"), actor: owner.id, projectId: project, title: "Search" })).id;
      const roles = new Map<string, string[]>();
      const agent = async (nm: string, held: string[]): Promise<Principal> => {
        await principals.enroll(owner, { commandId: cid("e"), kind: "agent", name: nm, grants: [{ action: "task.read", project }] });
        const p = await principals.authenticate((await principals.issueCredential(owner, `agent:${nm}`)).token);
        roles.set(p.id, held);
        return p;
      };
      const runner = new CommandRunner(world.storage, projects.epoch, options);
      const plant = async (kind: string, id: string, body: object): Promise<void> => {
        const found = await runner.get(kind, id);
        await runner.command("test.plant", { commandId: cid("plant"), actor: owner.id }, async () => ({ payload: { kind, id }, build: async () => ({ ref: { kind, id }, creates: found === undefined, changes: [found === undefined ? { type: "create" as const, ref: { kind, id }, body: body as JsonObject } : { type: "update" as const, ref: { kind, id }, expectedRevision: found.revision, body: body as JsonObject }], detail: {} }) }));
      };
      const rolesOf = async (id: string): Promise<string[]> => roles.get(id) ?? [];
      // The QA service tells the documentation service, as the controller wires them; `between` runs once between a gate read and the verification's write.
      let docs!: DocObligationService;
      const hookErrors: unknown[] = [];
      const qa = QaEvidenceService.withEpoch(world.storage, projects.epoch, {
        rolesOf,
        recorded: async (e) => { try { await docs.afterQaEvidence(e); } catch (error) { hookErrors.push(error); throw error; } },
        invalidated: async (e) => { try { await docs.afterQaInvalidation(e); } catch (error) { hookErrors.push(error); throw error; } },
      }, options);
      let between: (() => Promise<void>) | undefined;
      docs = DocObligationService.withEpoch(world.storage, projects.epoch, {
        rolesOf,
        gate: async (by, s) => { const { gate, reads } = await qa.gateBound(by, s); const run = between; between = undefined; if (run !== undefined) await run(); return { ...gate, reads }; },
        newestChecked: async (by, t) => (await qa.list(by, t)).items.find((e) => e.source === "independent")?.submissionId,
        projects, assignments,
      }, options);
      const ann = await agent("ann", ["author"]);
      const quinn = await agent("quinn", ["qa"]);
      const dora = await agent("dora", ["docs"]);
      const code = async (task: string, tree: string, submittedAt = "2026-11-20T09:00:00.000Z"): Promise<string> => {
        const id = derivedId("sbm", cid("code"));
        await plant("submission", id, { taskId: task, projectId: project, kind: "code", role: "author", submittedBy: ann.id, submittedAt, makesCommit: true, base: "c".repeat(40), tree, patchId: "d".repeat(40), evidence: [] });
        return id;
      };
      // The login task's contract (version 1); a later version changes what the work must be.
      const contract = (v: number, criteria: string[]) => ({ taskId: login, projectId: project, version: v, changedBy: owner.id, acceptanceCriteria: criteria, priority: 5, budget: {}, workClass: "P", requiredEvidence: [], checks: [{ name: "unit", run: ["true"] }], permissions: [], recovery: "native-continuation" });
      await plant("task-contract-version", `${login}.1`, { ...contract(1, ["works"]), changedAt: "2026-11-20T08:00:00.000Z" });
      await plant("task-contract", login, contract(1, ["works"]));
      const checked = (by: Principal, sub: string, result: "passed" | "failed" = "passed", commandId = cid("qa")) =>
        qa.record(by, { commandId, submissionId: sub, criteriaRevision: sub === subS ? 0 : 1, environment: "linux", observedAt: "2026-11-20T09:30:00.000Z", checks: [{ name: "unit", result }] });
      let subS = "";
      const documentChange = async (): Promise<string> => {
        const id = derivedId("sbm", cid("doc"));
        await plant("submission", id, { taskId: login, projectId: project, kind: "document", role: "docs", submittedBy: dora.id, submittedAt: "2026-11-20T09:40:00.000Z", makesCommit: false, artifactDigest: `sha256:${"e".repeat(64)}`, evidence: [] });
        return id;
      };
      const read = async (id: string): Promise<DocObligationBody & { revision: number }> => (await docs.get(owner, id)) as unknown as DocObligationBody & { revision: number };

      const guide = (await docs.record(owner, { commandId: cid("r"), projectId: project, title: "User guide", location: "docs/guide.md", audience: "user", owner: dora.id, applicableVersion: "1.0", implementationRefs: [login], claims: [{ text: "Sign in with a passkey", taskId: login }] })).id;
      const searchDoc = (await docs.record(owner, { commandId: cid("r"), projectId: project, title: "Search help", location: "docs/search.md", audience: "support", owner: dora.id, applicableVersion: "1.0", implementationRefs: [search] })).id;

      // The author's self-check never counts for a gate, so it checks nothing.
      const sub1 = await code(login, treeA);
      assert.equal((await checked(ann, sub1)).source, "self");
      assert.deepEqual([(await read(guide)).reasons, (await read(guide)).updates.length], [undefined, 0], "a self-check flags nothing");

      // Independent evidence that passes: the task's unverified document is flagged by itself with an update task for its keeper, linked to that code; the other task's document is untouched.
      const q1 = await checked(quinn, sub1, "passed", "q1");
      let g = await read(guide);
      assert.deepEqual([g.state, g.reasons?.map((r) => r.kind), g.updates.length, g.updates[0]?.requestedBy], ["unverified", ["behavior_changed"], 1, DOC_AUTO_PRINCIPAL.id]);
      assert.equal((g.reasons![0] as { submissionId: string }).submissionId, sub1);
      const firstUpdate = g.updates[0]!.taskId;
      assert.equal((await assignments.getAssignment(firstUpdate))?.owner?.id, "dora", "assigned to the document's keeper");
      assert.equal((await read(searchDoc)).updates.length, 0, "a document of another task is not flagged");
      assert.deepEqual(hookErrors, []);

      // The same QA command again (a crash after the record) is the same documentation check: nothing is flagged twice.
      const assignmentRecord = await runner.get("assignment", assignmentIdOf(firstUpdate));
      assert.ok(assignmentRecord !== undefined);
      const again = await checked(quinn, sub1, "passed", "q1");
      assert.equal(again.replayed, true);
      assert.equal(again.id, q1.id);
      g = await read(guide);
      assert.equal(g.updates.length, 1, "a repeat flags nothing twice");

      // Verified with a document change made since the flag.
      const doc1 = await documentChange();
      const v1 = await docs.verify(dora, { commandId: cid("v"), obligationId: guide, expectedRevision: g.revision, documentSubmissionId: doc1, evidence: [sub1] });
      assert.deepEqual(v1.settled, [firstUpdate]);

      // New code of the task passes QA: the verified document goes stale by itself, against the new tree.
      const sub2 = await code(login, treeB);
      await checked(quinn, sub2);
      g = await read(guide);
      assert.equal(g.state, "stale");
      assert.deepEqual(g.reasons?.map((r) => [r.kind, (r as { submissionId: string }).submissionId, (r as { from?: string }).from]), [["behavior_changed", sub2, treeA]]);
      assert.equal(g.updates.filter((u) => u.state === "open").length, 1);

      // QA evidence changes between the gate read and the write: the verification is refused (the gate's records are checked in the write), and nothing is written.
      const doc2 = await documentChange();
      between = async () => { await checked(quinn, sub2, "failed"); };
      await refuses("stale_revision", () => docs.verify(dora, { commandId: cid("v"), obligationId: guide, expectedRevision: g.revision, documentSubmissionId: doc2, evidence: [sub2] }), /QA evidence of the code named changed/);
      assert.equal(between, undefined, "the change ran between the read and the write");
      assert.equal((await read(guide)).state, "stale", "nothing was verified on the old verdict");
      // Read again, the gate fails: the claim would be unsupported.
      await refuses("invalid_command", () => docs.verify(dora, { commandId: cid("v"), obligationId: guide, expectedRevision: g.revision, documentSubmissionId: doc2, evidence: [sub2] }), /unsupported: "Sign in with a passkey"/);
      // Passing again: the documentation check finds nothing new for that code (the document is already flagged for it); the verification goes through.
      await checked(quinn, sub2);
      g = await read(guide);
      assert.equal(g.updates.filter((u) => u.state === "open").length, 1, "the document's flag for that code is not repeated");
      // A change to a record no gate read (evidence of another task) does not refuse the verification.
      subS = await code(search, treeA);
      between = async () => { await checked(quinn, subS); };
      const v2 = await docs.verify(dora, { commandId: cid("v"), obligationId: guide, expectedRevision: g.revision, documentSubmissionId: doc2, evidence: [sub2] });
      assert.equal(v2.settled.length, 1);
      assert.equal((await read(guide)).state, "verified");
      assert.equal((await read(searchDoc)).reasons?.[0]?.kind, "behavior_changed", "the other task's evidence flagged its own document");

      // The task contract changes what the work must be: the QA check invalidates the evidence, and the verified document is flagged by itself as having lost its evidence (not as a behaviour change).
      // Lost evidence is looked for only where a gate no longer passes: an invalidation elsewhere flags nothing for a document whose own evidence still passes.
      const elsewhere = await docs.afterQaInvalidation({ taskId: login, evidence: [{ evidenceId: derivedId("qae", cid("none")), submissionId: sub1 }] });
      assert.deepEqual(elsewhere.flagged, []);
      g = await read(guide);
      assert.equal(g.state, "verified");
      // The task contract changes between the gate read and the write of a new verification: refused, although the evidence records themselves did not change.
      const doc3 = await documentChange();
      between = async () => { await plant("task-contract", login, contract(2, ["works", "and faster"])); };
      await refuses("stale_revision", () => docs.verify(dora, { commandId: cid("v"), obligationId: guide, expectedRevision: g.revision, documentSubmissionId: doc3, evidence: [sub2] }), /QA evidence of the code named changed/);
      assert.equal(between, undefined);
      assert.equal((await read(guide)).verification?.documentSubmissionId, doc2, "the earlier verification stands");
      const verifiedRevision = g.revision;
      const inval = await qa.check(owner, { commandId: cid("chk"), taskId: login });
      assert.ok(inval.invalidated.length >= 1, JSON.stringify(inval));
      g = await read(guide);
      assert.ok(g.revision > verifiedRevision);
      assert.equal(g.state, "stale");
      assert.deepEqual(g.reasons?.map((r) => [r.kind, (r as { submissionId: string }).submissionId]), [["evidence_lost", sub2]]);
      const lostUpdate = g.updates.find((u) => u.state === "open")!;
      assert.equal(lostUpdate.requestedBy, DOC_AUTO_PRINCIPAL.id);
      assert.equal((await assignments.getAssignment(lostUpdate.taskId))?.owner?.id, "dora");
      // Checking for lost evidence again (the same invalidation) is the same command: nothing twice.
      const of = async (id: string): Promise<string> => ((await qa.get(owner, id)) as unknown as { submissionId: string }).submissionId;
      const repeat = await docs.afterQaInvalidation({ taskId: login, evidence: await Promise.all(inval.invalidated.map(async (id) => ({ evidenceId: id, submissionId: await of(id) }))) });
      assert.deepEqual(repeat.flagged, []);
      assert.equal((await read(guide)).updates.filter((u) => u.state === "open").length, 1);
      assert.deepEqual(hookErrors, []);

      // QA evidence recorded late on older code of a task (newer code was already tested) does not move the task's documents back to the older code: a document flagged for, or verified against, the
      // newer code stays as it is, so its keeper verifies against the newest tested code. Going back to the old tree is a new code submission, which flags the document again.
      const exportTask = (await projects.createTask({ commandId: cid("t"), actor: owner.id, projectId: project, title: "Export" })).id;
      const exportDoc = (await docs.record(owner, { commandId: cid("r"), projectId: project, title: "Export help", location: "docs/export.md", audience: "user", owner: dora.id, applicableVersion: "1.0", implementationRefs: [exportTask] })).id;
      const exportCheck = (sub: string) => qa.record(quinn, { commandId: cid("qa"), submissionId: sub, criteriaRevision: 0, environment: "linux", observedAt: "2026-11-20T09:30:00.000Z", checks: [{ name: "unit", result: "passed" }] });
      const older = await code(exportTask, treeA, "2026-11-20T09:00:00.000Z");
      const newer = await code(exportTask, treeB, "2026-11-20T09:10:00.000Z");
      await exportCheck(newer);
      await exportCheck(older);
      let x = await read(exportDoc);
      assert.deepEqual(x.reasons?.map((r) => (r as { submissionId: string }).submissionId), [newer], "late evidence on older code does not flag the document for that code");
      const docX = await documentChange();
      await docs.verify(dora, { commandId: cid("v"), obligationId: exportDoc, expectedRevision: x.revision, documentSubmissionId: docX, evidence: [newer] });
      await exportCheck(older);
      x = await read(exportDoc);
      assert.deepEqual([x.state, x.reasons], ["verified", undefined], "a document verified against newer code stays verified");
      const back = await code(exportTask, treeA, "2026-11-20T09:20:00.000Z");
      await exportCheck(back);
      x = await read(exportDoc);
      assert.deepEqual([x.state, x.reasons?.map((r) => (r as { submissionId: string }).submissionId)], ["stale", [back]], "going back to the old tree in a new submission flags it");
      // The manual check naming older code is unchanged: it flags the document for that code even though it was flagged for newer code.
      assert.deepEqual((await docs.impact(owner, { commandId: cid("i"), taskId: exportTask, submissionId: older })).flagged, [exportDoc], "a manual check naming older code still flags");
      assert.deepEqual((await read(exportDoc)).reasons?.map((r) => (r as { submissionId: string }).submissionId), [back, older]);
      assert.deepEqual(hookErrors, []);

      // A release's documentation check has one command ID per candidate, project and version.
      assert.equal(releaseDocsCommandId("rcn-1", project, "2.0"), releaseDocsCommandId("rcn-1", project, "2.0"));
      assert.notEqual(releaseDocsCommandId("rcn-1", project, "2.0"), releaseDocsCommandId("rcn-1", project, "2.1"));
      assert.notEqual(releaseDocsCommandId("rcn-1", project, "2.0"), releaseDocsCommandId("rcn-2", project, "2.0"));
    } finally {
      await world.close();
    }
  });
}
