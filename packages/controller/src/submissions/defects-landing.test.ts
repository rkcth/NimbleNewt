import assert from "node:assert/strict";
import { after, test } from "node:test";
import { OPERATIONS } from "../api/operations.js";
import { DomainError } from "../domain/errors.js";
import { derivedId } from "../domain/ids.js";
import { ProjectService } from "../domain/service.js";
import { backends, stopServer } from "../domain/testing/backends.js";
import { CommandRunner } from "../domain/runner.js";
import { PrincipalService, type Principal } from "../security/index.js";
import type { JsonObject } from "../storage/types.js";
import { AcceptanceService, DefectService, landingDefectsGate } from "./index.js";

after(stopServer);

const options = { clock: () => "2026-11-18T10:00:00.000Z", pause: async () => undefined };
let n = 0;
const cid = (label: string): string => `${label}-${n++}`;

for (const backend of backends) {
  test(`${backend.name}: the landing gate reads the unfinished defects of a task: finished ones (fixed, withdrawn, accepted by the owner) do not count, escalated first, bounded list, other tasks left out (card Q04)`, async () => {
    const world = await backend.open();
    try {
      const projects = await ProjectService.open(world.storage, { holder: "c1", ...options });
      const principals = PrincipalService.withEpoch(world.storage, projects.epoch, options);
      const owner = await principals.authenticate((await principals.bootstrapOwner({ name: "rob" })).token);
      const p1 = (await projects.createProject({ commandId: cid("p"), actor: owner.id, name: "P1" })).id;
      const p2 = (await projects.createProject({ commandId: cid("p"), actor: owner.id, name: "P2" })).id;
      const t1 = (await projects.createTask({ commandId: cid("t"), actor: owner.id, projectId: p1, title: "T1" })).id;
      const t2 = (await projects.createTask({ commandId: cid("t"), actor: owner.id, projectId: p2, title: "T2" })).id;
      const roles = new Map<string, string[]>();
      const agent = async (nm: string, held: string[], inProjects: string[]): Promise<Principal> => {
        await principals.enroll(owner, { commandId: cid("e"), kind: "agent", name: nm, grants: inProjects.map((project) => ({ action: "task.read", project })) });
        const p = await principals.authenticate((await principals.issueCredential(owner, `agent:${nm}`)).token);
        roles.set(p.id, held);
        return p;
      };
      const runner = new CommandRunner(world.storage, projects.epoch, options);
      const plant = async (project: string, task: string): Promise<string> => {
        const art = derivedId("art", cid("art"));
        await runner.command("test.plant", { commandId: cid("plant"), actor: owner.id }, async () => ({ payload: { id: art }, build: async () => ({ ref: { kind: "artifact", id: art }, creates: true, changes: [{ type: "create" as const, ref: { kind: "artifact", id: art }, body: { name: "one", projectId: project, taskId: task, entries: [], manifestDigest: "m-one", totalBytes: 0, createdBy: owner.id } as unknown as JsonObject }], detail: {} }) }));
        return art;
      };
      const acc = AcceptanceService.withEpoch(world.storage, projects.epoch, {
        rolesOf: async (id) => roles.get(id) ?? [],
        contractVersion: async () => 0,
        verifyArtifact: async () => ({ ok: true, problems: 0 }),
        reviewersAvailableIn: async (_p, worker) => [...roles].filter(([id, r]) => id !== worker && r.includes("reviewer")).map(([id]) => id),
      }, options);
      // One repair and review cycle, so a single failed check escalates.
      const svc = DefectService.withEpoch(world.storage, projects.epoch, {
        rolesOf: async (id) => roles.get(id) ?? [],
        mayReadDeliverable: async (by, id) => (await acc.get(by, id)) !== undefined,
        cycleLimit: async () => 1,
      }, options);
      const ann = await agent("ann", ["author", "docs"], [p1, p2]);
      const rev = await agent("rev", ["reviewer"], [p1, p2]);
      const far = await agent("far", ["reviewer"], [p2]);

      const deliverable = async (project: string, task: string, title: string): Promise<{ id: string; art: string }> => {
        const art = await plant(project, task);
        const made = await acc.draft(ann, { commandId: cid("d"), taskId: task, type: "document", title, artifacts: [{ artifactId: art }] });
        await acc.submit(ann, { commandId: cid("s"), id: made.id, expectedRevision: made.revision, contractVersion: 0 });
        await acc.startReview(owner, { commandId: cid("r"), id: made.id, version: 1 });
        await acc.reject(owner, { commandId: cid("j"), id: made.id, version: 1, reason: "not good enough" });
        return { id: made.id, art };
      };
      const newVersion = async (d: { id: string; art: string }): Promise<number> => {
        const cur = (await acc.get(owner, d.id))!;
        const nv = await acc.newVersion(ann, { commandId: cid("n"), id: d.id, expectedRevision: cur["revision"] as number, artifacts: [{ artifactId: d.art }] });
        await acc.submit(ann, { commandId: cid("s"), id: d.id, expectedRevision: nv.revision, contractVersion: 0 });
        return (await acc.get(owner, d.id))!["currentVersion"] as number;
      };
      const code = (e: unknown, c: string): boolean => e instanceof DomainError && e.code === c;
      const rev2 = await agent("rev2", ["reviewer"], [p1]);
      const g1 = await deliverable(p1, t1, "Guide");
      const gate = landingDefectsGate(svc);
      const report = (d: { id: string }, by: Principal, finding: string, severity = "major"): Promise<{ id: string; revision: number }> => svc.report(by, { commandId: cid("f"), deliverableId: d.id, version: 1, finding, severity });
      const view = async (task = t1) => (await gate(task))!;

      // No defect yet: nothing is unfinished. A task that does not exist is not read (the gate then says "could not be read").
      assert.deepEqual(await view(), { taskId: t1, checked: 0, unresolved: 0, items: [] });
      assert.equal(await gate("task-zzzzzzzzzzzzzzzzzzzz"), undefined);
      await assert.rejects(() => gate("not a task"), (e) => code(e, "invalid_command"));

      const minor = await report(g1, rev, "typo in step 1", "minor");
      const major = await report(g1, rev, "backup step missing", "major");
      const crit = await report(g1, rev, "wrong command", "critical");
      let v = await view();
      assert.deepEqual([v.checked, v.unresolved], [3, 3]);
      assert.deepEqual(v.items.map((x) => [x.id, x.severity, x.state, x.deliverableTitle]), [[crit.id, "critical", "open", "Guide"], [major.id, "major", "open", "Guide"], [minor.id, "minor", "open", "Guide"]], "most severe first");
      assert.equal(v.items[0]!.finding, "wrong command");

      // A repair waiting for its check is still unfinished; a repair found fixed finishes it.
      const v2 = await newVersion(g1);
      await svc.repair(ann, { commandId: cid("rp"), id: minor.id, version: v2 });
      v = await view();
      assert.deepEqual([v.unresolved, v.items.find((x) => x.id === minor.id)?.state], [3, "repair-submitted"]);
      await svc.review(rev, { commandId: cid("rv"), id: minor.id, verdict: "fixed" });
      v = await view();
      assert.deepEqual([v.checked, v.unresolved, v.items.some((x) => x.id === minor.id)], [3, 2, false], "a fixed defect no longer blocks");

      // A failed check escalates (one cycle): it is listed first whatever its severity.
      await svc.repair(ann, { commandId: cid("rp"), id: major.id, version: v2 });
      await svc.review(rev, { commandId: cid("rv"), id: major.id, verdict: "not-fixed", reason: "still missing" });
      v = await view();
      assert.deepEqual(v.items.map((x) => [x.id, x.state]), [[major.id, "escalated"], [crit.id, "open"]], "escalated first");

      // Withdrawn and owner-accepted defects stand finished; the count of everything reported stays.
      await svc.withdraw(rev, { commandId: cid("w"), id: crit.id, reason: "read the wrong version" });
      v = await view();
      assert.deepEqual([v.checked, v.unresolved, v.items.map((x) => x.id)], [3, 1, [major.id]]);
      await svc.override(owner, { commandId: cid("o"), id: major.id, outcome: "accept-as-is", reason: "ship it" });
      assert.deepEqual(await view(), { taskId: t1, checked: 3, unresolved: 0, items: [] });
      // The owner sending it back to repair (a repair-again decision needs an unresolved defect: a new one) is unfinished again.
      const again = await report(g1, rev, "a new finding");
      assert.deepEqual((await view()).items.map((x) => x.id), [again.id]);

      // The list is bounded: many unfinished defects are counted in full and only the first LANDING_LISTED are listed. Another task's defects are not this task's.
      const g2 = await deliverable(p1, t1, "Guide 2");
      const many: string[] = [];
      for (let i = 0; i < 6; i++) many.push((await report(g2, rev, `finding ${i}`, "minor")).id);
      v = await view();
      assert.deepEqual([v.unresolved, v.items.length], [7, 5]);
      assert.equal(v.items[0]!.id, again.id, "the more severe one first");
      // The clock is fixed, so the rest tie on severity and time and are ordered by ID.
      const rest = v.items.slice(1).map((x) => x.id);
      assert.deepEqual(rest, [...many].sort().slice(0, 4));
      const g3 = await deliverable(p2, t2, "Other task");
      await report(g3, far, "elsewhere");
      assert.deepEqual([(await view(t2)).unresolved, (await view(t1)).unresolved], [1, 7]);
      assert.deepEqual((await view(t2)).items.map((x) => x.deliverableTitle), ["Other task"]);
      void rev2;
    } finally { await world.close(); }
  });
}
