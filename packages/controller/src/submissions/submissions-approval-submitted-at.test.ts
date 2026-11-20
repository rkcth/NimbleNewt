// Card P10: `SubmissionService.approvalOf` answers `submittedAt` (the landing queue orders by it and refuses an older submission of a task while a newer one is queued), as the time the code submission was recorded.
import assert from "node:assert/strict";
import { after, test } from "node:test";
import { ProjectService } from "../domain/service.js";
import { backends, stopServer } from "../domain/testing/backends.js";
import { PrincipalService } from "../security/index.js";
import { SubmissionService } from "./index.js";

after(stopServer);

const BASE = "c".repeat(40), T1 = "a".repeat(40), T2 = "b".repeat(40), PATCH = "d".repeat(40);

for (const backend of backends) {
  test(`${backend.name}: approvalOf answers each code submission's own recorded submittedAt, approved or not (card P10)`, async () => {
    const world = await backend.open();
    try {
      let now = "2026-11-19T09:00:00.000Z";
      const options = { clock: () => now, pause: async () => undefined };
      const projects = await ProjectService.open(world.storage, { holder: "c1", ...options });
      const principals = PrincipalService.withEpoch(world.storage, projects.epoch, options);
      const owner = await principals.authenticate((await principals.bootstrapOwner({ name: "rob" })).token);
      const project = (await projects.createProject({ commandId: "p", actor: owner.id, name: "P" })).id;
      const task = (await projects.createTask({ commandId: "t", actor: owner.id, projectId: project, title: "T" })).id;
      for (const name of ["ann", "rev"]) await principals.enroll(owner, { commandId: `e-${name}`, kind: "agent", name, grants: [{ action: "task.read", project }] });
      const ann = await principals.authenticate((await principals.issueCredential(owner, "agent:ann")).token);
      const rev = await principals.authenticate((await principals.issueCredential(owner, "agent:rev")).token);
      const roles = new Map<string, string[]>([[ann.id, ["author"]], [rev.id, ["reviewer"]]]);
      const svc = SubmissionService.withEpoch(world.storage, projects.epoch, async (id) => roles.get(id) ?? [], { ...options, reviewersAvailableIn: async () => ["agent:rev"] });
      const first = await svc.record(ann, { commandId: "s1", taskId: task, kind: "code", role: "author", base: BASE, tree: T1, patchId: PATCH });
      now = "2026-11-19T09:30:00.000Z";
      const second = await svc.record(ann, { commandId: "s2", taskId: task, kind: "code", role: "author", base: BASE, tree: T2, patchId: PATCH });
      // Not yet approved: the time is still answered.
      assert.equal((await svc.approvalOf(first.id))?.submittedAt, "2026-11-19T09:00:00.000Z");
      // A review recorded later does not change a submission's own time.
      now = "2026-11-19T10:00:00.000Z";
      await svc.record(rev, { commandId: "r1", taskId: task, kind: "review", role: "reviewer", subject: first.id, verdict: "approve" });
      await svc.record(rev, { commandId: "r2", taskId: task, kind: "review", role: "reviewer", subject: second.id, verdict: "approve" });
      const [a, b] = [await svc.approvalOf(first.id), await svc.approvalOf(second.id)];
      assert.deepEqual([a?.approved, a?.submittedAt, b?.approved, b?.submittedAt], [true, "2026-11-19T09:00:00.000Z", true, "2026-11-19T09:30:00.000Z"]);
    } finally { await world.close(); }
  });
}
