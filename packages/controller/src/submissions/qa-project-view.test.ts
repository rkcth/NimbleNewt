import assert from "node:assert/strict";
import { after, test } from "node:test";
import { DomainError } from "../domain/errors.js";
import { derivedId } from "../domain/ids.js";
import { CommandRunner } from "../domain/runner.js";
import { ProjectService } from "../domain/service.js";
import { backends, stopServer } from "../domain/testing/backends.js";
import { PrincipalService, type Principal } from "../security/index.js";
import type { JsonObject } from "../storage/types.js";
import { QaEvidenceService } from "./index.js";

after(stopServer);

const options = { clock: () => "2026-11-22T10:00:00.000Z", pause: async () => undefined };
let n = 0;
const cid = (label: string): string => `${label}-${n++}`;

for (const backend of backends) {
  test(`${backend.name}: the project QA view lists each task's newest code version as waiting, stale, failing or passing, and hides what the caller may not read (card Q02)`, async () => {
    const world = await backend.open();
    try {
      const projects = await ProjectService.open(world.storage, { holder: "c1", ...options });
      const principals = PrincipalService.withEpoch(world.storage, projects.epoch, options);
      const owner = await principals.authenticate((await principals.bootstrapOwner({ name: "rob" })).token);
      const project = (await projects.createProject({ commandId: cid("p"), actor: owner.id, name: "P" })).id;
      const elsewhere = (await projects.createProject({ commandId: cid("p"), actor: owner.id, name: "Q" })).id;
      const roles = new Map<string, string[]>();
      const agent = async (nm: string, held: string[], grants: { project: string }[]): Promise<Principal> => {
        await principals.enroll(owner, { commandId: cid("e"), kind: "agent", name: nm, grants: grants.map((g) => ({ action: "task.read", project: g.project })) });
        const p = await principals.authenticate((await principals.issueCredential(owner, `agent:${nm}`)).token);
        roles.set(p.id, held);
        return p;
      };
      const runner = new CommandRunner(world.storage, projects.epoch, options);
      const plant = async (kind: string, id: string, body: object): Promise<void> => {
        await runner.command("test.plant", { commandId: cid("plant"), actor: owner.id }, async () => ({ payload: { kind, id }, build: async () => ({ ref: { kind, id }, creates: true, changes: [{ type: "create" as const, ref: { kind, id }, body: body as JsonObject }], detail: {} }) }));
      };
      const svc = QaEvidenceService.withEpoch(world.storage, projects.epoch, { rolesOf: async (id) => roles.get(id) ?? [] }, options);
      const ann = await agent("ann", ["author"], [{ project }]);
      const qa = await agent("qa", ["qa"], [{ project }]);
      const stranger = await agent("stranger", ["qa"], [{ project: elsewhere }]);

      const mkTask = async (title: string): Promise<string> => (await projects.createTask({ commandId: cid("t"), actor: owner.id, projectId: project, title })).id;
      const treeOf = (c: string): string => c.repeat(64);
      const code = async (taskId: string, at: string, c: string, inProject = project): Promise<string> => {
        const id = derivedId("sbm", cid("sub"));
        await plant("submission", id, { taskId, projectId: inProject, kind: "code", role: "author", submittedBy: ann.id, submittedAt: at, makesCommit: true, base: "a".repeat(40), tree: treeOf(c), patchId: "c".repeat(40), evidence: [] });
        return id;
      };
      const evidence = async (submissionId: string, checks: { name: string; result: string }[], by: Principal = qa) => svc.record(by, { commandId: cid("r"), submissionId, criteriaRevision: 0, environment: "linux", observedAt: "2026-11-22T09:30:00.000Z", checks });

      assert.deepEqual(await svc.project(owner, project), { projectId: project, counts: { passes: 0, waiting: 0, stale: 0, failing: 0 }, items: [], truncated: false, scanLimited: false }, "no code, nothing waits");

      const tWait = await mkTask("Waits");
      const tSelf = await mkTask("Self only");
      const tFail = await mkTask("Fails");
      const tPass = await mkTask("Passes");
      const tNew = await mkTask("Newest counts");
      const tNone = await mkTask("No code at all");
      void tNone;
      // The contract of the waiting task names a required check: with no evidence at all the gate also reads it as missing, and the task still waits for QA (it is not "failing").
      const cw = { taskId: tWait, projectId: project, version: 1, changedBy: owner.id, acceptanceCriteria: ["works"], priority: 5, budget: {}, workClass: "P", requiredEvidence: [], checks: [{ name: "unit", run: ["true"] }], permissions: [], recovery: "native-continuation" };
      await plant("task-contract", tWait, cw);
      await plant("task-contract-version", `${tWait}.1`, { ...cw, changedAt: "2026-11-22T07:00:00.000Z" });
      const sWait = await code(tWait, "2026-11-22T08:00:00.000Z", "1");
      const sSelf = await code(tSelf, "2026-11-22T08:00:00.000Z", "2");
      await evidence(sSelf, [{ name: "unit", result: "passed" }], ann);
      const sFail = await code(tFail, "2026-11-22T08:00:00.000Z", "3");
      await evidence(sFail, [{ name: "unit", result: "passed" }, { name: "ui", result: "blocked" }]);
      const sPass = await code(tPass, "2026-11-22T08:00:00.000Z", "4");
      await evidence(sPass, [{ name: "unit", result: "passed" }]);
      // The newest code of a task is the work: the older version passed, the newer has nothing yet.
      const sOld = await code(tNew, "2026-11-22T07:00:00.000Z", "5");
      await evidence(sOld, [{ name: "unit", result: "passed" }]);
      const sNewest = await code(tNew, "2026-11-22T08:30:00.000Z", "6");
      // Code of another project is not in this project's view.
      const tOther = (await projects.createTask({ commandId: cid("t"), actor: owner.id, projectId: elsewhere, title: "Elsewhere" })).id;
      await code(tOther, "2026-11-22T08:00:00.000Z", "7", elsewhere);

      // A newer review (not code) on a waiting task changes nothing: only code is the work.
      const review = derivedId("sbm", cid("sub"));
      await plant("submission", review, { taskId: tWait, projectId: project, kind: "review", role: "reviewer", submittedBy: qa.id, submittedAt: "2026-11-22T09:59:00.000Z", makesCommit: false, tree: treeOf("9"), subject: sWait, verdict: "approve", evidence: [] });
      const view = await svc.project(owner, project);
      assert.deepEqual(view.counts, { passes: 1, waiting: 3, stale: 0, failing: 1 });
      assert.deepEqual(view.items.map((i) => [i.title, i.state, i.submissionId]).sort(), [
        ["Fails", "failing", sFail], ["Newest counts", "waiting", sNewest], ["Passes", "passes", sPass], ["Self only", "waiting", sSelf], ["Waits", "waiting", sWait],
      ].sort());
      assert.deepEqual(view.items.map((i) => i.state), ["waiting", "waiting", "waiting", "failing", "passes"], "what waits comes first, then stale, failing, passing");
      assert.deepEqual(view.items.find((i) => i.taskId === tFail)?.counts, { passed: 1, failed: 0, blocked: 1, notRun: 0, missing: 0 }, "the four results stay apart");
      assert.equal(view.items.find((i) => i.taskId === tWait)?.tree, treeOf("1"));
      assert.deepEqual(view.items.find((i) => i.taskId === tWait)?.reasons, ["no_evidence", "check_missing"]);
      assert.equal(view.items.some((i) => i.submissionId === sOld), false, "an older version is not listed");

      // Evidence that no longer holds is "stale", not "waiting".
      const c1 = (v: number, criteria: string[]) => ({ taskId: tPass, projectId: project, version: v, changedBy: owner.id, acceptanceCriteria: criteria, priority: 5, budget: {}, workClass: "P", requiredEvidence: [], checks: [], permissions: [], recovery: "native-continuation" });
      await plant("task-contract", tPass, c1(1, ["works"]));
      await plant("task-contract-version", `${tPass}.1`, { ...c1(1, ["works"]), changedAt: "2026-11-22T09:40:00.000Z" });
      const staled = await svc.project(owner, project);
      assert.equal(staled.items.find((i) => i.taskId === tPass)?.state, "stale", "the criteria changed after the evidence: it no longer holds");
      assert.deepEqual([staled.counts.stale, staled.counts.passes], [1, 0]);

      // Who may read what: a qa agent of the project sees it; an agent of another project sees nothing of it, and an unknown project reads the same.
      assert.equal((await svc.project(qa, project)).items.length, 5);
      await assert.rejects(() => svc.project(stranger, project), (e: unknown) => e instanceof DomainError && e.code === "not_found");
      await assert.rejects(() => svc.project(owner, "proj-" + "a".repeat(20)), (e: unknown) => e instanceof DomainError && e.code === "not_found");
      await assert.rejects(() => svc.project(owner, "nope"), (e: unknown) => e instanceof DomainError && e.code === "invalid_command");
      // A task credential (scoped to one task) is refused the project-wide view, even for its own task's project: it has the qa view of its own task.
      await assert.rejects(() => svc.project({ ...qa, taskScope: { taskId: tWait, projectId: project } }, project), (e: unknown) => e instanceof DomainError && e.code === "not_found");
      // Reading changes nothing: the view twice is the same.
      assert.deepEqual(await svc.project(owner, project), staled);

      // A submission that names this project for a task of another project is not shown: the task's own project decides.
      const stray = await code(tOther, "2026-11-22T09:00:00.000Z", "8");
      const afterStray = await svc.project(owner, project);
      assert.equal(afterStray.items.some((i) => i.taskId === tOther || i.submissionId === stray), false, "another project's task is never listed");
      assert.deepEqual(afterStray.counts, staled.counts);

      // Bounds: the gates of at most `tasks` tasks are read, the newest code first (the stray task is looked at and skipped); a short scan says so.
      let gates = 0;
      const gateOf = svc.gate.bind(svc);
      (svc as unknown as { gate: typeof svc.gate }).gate = async (by, id) => { gates++; return gateOf(by, id); };
      const two = await svc.project(owner, project, { tasks: 2, pageSize: 500, reads: 20 });
      assert.equal(gates, 2, "only two gates were read");
      assert.equal(two.items.length, 2);
      assert.equal(two.truncated, true);
      assert.equal(two.scanLimited, false);
      const firstTied = [tWait, tSelf, tFail, tPass].sort()[0]!;
      assert.deepEqual(two.items.map((i) => i.taskId).sort(), [tNew, firstTied].sort(), "the newest code first, then by task ID");
      assert.equal(two.counts.passes + two.counts.waiting + two.counts.stale + two.counts.failing, 2, "the counts cover the tasks read");
      gates = 0;
      const short = await svc.project(owner, project, { tasks: 200, pageSize: 2, reads: 1 });
      assert.equal(short.scanLimited, true, "a scan that stops before the end says so");
      assert.ok(gates <= 2 && short.items.length <= 2);
      assert.equal((await svc.project(owner, project, { tasks: 200, pageSize: 2, reads: 20 })).scanLimited, false, "small pages to the end are complete");
    } finally { await world.close(); }
  });
}
