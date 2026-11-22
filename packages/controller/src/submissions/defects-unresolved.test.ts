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
import { AcceptanceService, DefectService } from "./index.js";

after(stopServer);

const options = { clock: () => "2026-11-18T10:00:00.000Z", pause: async () => undefined };
let n = 0;
const cid = (label: string): string => `${label}-${n++}`;

for (const backend of backends) {
  test(`${backend.name}: the unfinished defects of a project, escalated first, only where the caller may read (card Q04)`, async () => {
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
      // Project 1 allows one repair and review cycle, project 2 three.
      const svc = DefectService.withEpoch(world.storage, projects.epoch, {
        rolesOf: async (id) => roles.get(id) ?? [],
        mayReadDeliverable: async (by, id) => (await acc.get(by, id)) !== undefined,
        cycleLimit: async (project) => (project === p1 ? 1 : 3),
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
      const g1 = await deliverable(p1, t1, "Guide");
      const g2 = await deliverable(p2, t2, "Manual");
      const report = (d: { id: string }, finding: string, severity: string): Promise<{ id: string }> => svc.report(rev, { commandId: cid("f"), deliverableId: d.id, version: 1, finding, severity });
      const critical = (await report(g1, "critical one", "critical")).id; // stays open
      const minor = (await report(g1, "minor one", "minor")).id; // stays open
      const failed = (await report(g1, "failed repair", "major")).id; // escalates (limit 1)
      const fixed = (await report(g1, "fixed one", "major")).id; // resolved
      const accepted = (await report(g1, "accepted one", "minor")).id; // overridden
      const waiting = (await report(g2, "manual one", "major")).id; // repaired, waits for a check
      const v2 = await newVersion(g1);
      for (const id of [failed, fixed, accepted]) await svc.repair(ann, { commandId: cid("rp"), id, version: v2 });
      await svc.review(rev, { commandId: cid("rv"), id: failed, verdict: "not-fixed", reason: "still wrong" });
      await svc.review(rev, { commandId: cid("rv"), id: fixed, verdict: "fixed" });
      await svc.review(rev, { commandId: cid("rv"), id: accepted, verdict: "not-fixed", reason: "still wrong" });
      await svc.override(owner, { commandId: cid("o"), id: accepted, outcome: "accept-as-is", reason: "ship it" });
      await svc.repair(ann, { commandId: cid("rp"), id: waiting, version: await newVersion(g2) });

      // 600 finished defect records whose IDs sort before every real one: the unfinished ones are found only on the second page of the scan (500 per page).
      for (let batch = 0; batch < 6; batch++) {
        const ids = Array.from({ length: 100 }, (_, i) => `dft-0${String(batch * 100 + i).padStart(19, "0")}`);
        await runner.command("test.plant", { commandId: cid("plant"), actor: owner.id }, async () => ({ payload: { batch }, build: async () => ({ ref: { kind: "defect", id: ids[0]! }, creates: true, changes: ids.map((id) => ({ type: "create" as const, ref: { kind: "defect", id }, body: { state: "resolved", projectId: p1, deliverableId: g1.id } as unknown as JsonObject })), detail: {} }) }));
      }

      // Project 1: the escalated one first, then the open ones by severity; the resolved and the accepted are not unfinished.
      const one = await svc.unresolved(owner, { projectId: p1 });
      assert.deepEqual(one.items.map((x) => [x.id, x.state, x.severity, x.cycles, x.limit]), [[failed, "escalated", "major", 1, 1], [critical, "open", "critical", 0, 1], [minor, "open", "minor", 0, 1]]);
      assert.deepEqual(one.counts, { escalated: 1, awaitingCheck: 0, open: 2 });
      assert.equal(one.scanLimited, false);
      // Project 2 keeps its own limit and its repaired defect counts as waiting for a check.
      const two = await svc.unresolved(owner, { projectId: p2 });
      assert.deepEqual(two.items.map((x) => [x.id, x.state, x.limit]), [[waiting, "repair-submitted", 3]]);
      assert.deepEqual(two.counts, { escalated: 0, awaitingCheck: 1, open: 0 });
      // The owner without a project sees every project's; only the escalated ones on request.
      assert.equal((await svc.unresolved(owner)).items.length, 4);
      assert.deepEqual((await svc.unresolved(owner, { escalatedOnly: true })).items.map((x) => x.id), [failed]);
      // The items are cut at the cap, the counts are not.
      const cut = await svc.unresolved(owner, { projectId: p1, cap: 1 });
      assert.deepEqual([cut.items.length, cut.counts.escalated + cut.counts.open], [1, 3]);
      // An agent reads only what it may read, and must name the project.
      assert.deepEqual((await svc.unresolved(far, { projectId: p2 })).items.map((x) => x.id), [waiting]);
      // A project the agent may not read is not found (its existence is not told), also for a task credential of another project.
      await assert.rejects(() => svc.unresolved(far, { projectId: p1 }), (e: unknown) => e instanceof DomainError && e.code === "not_found");
      await assert.rejects(() => svc.unresolved({ ...rev, taskScope: { taskId: t2, projectId: p2 } } as Principal, { projectId: p1 }), (e: unknown) => e instanceof DomainError && e.code === "not_found");
      assert.deepEqual((await svc.unresolved({ ...rev, taskScope: { taskId: t2, projectId: p2 } } as Principal, { projectId: p2 })).items.map((x) => x.id), [waiting]);
      // An agent that may read only one task of the project (a grant for that task) still sees the defects of that task's deliverables.
      const oneTask = { ...far, grants: [{ action: "task.read", project: p1, resource: { kind: "task", id: t1 } }] } as unknown as Principal;
      assert.deepEqual((await svc.unresolved(oneTask, { projectId: p1 })).counts, { escalated: 1, awaitingCheck: 0, open: 2 });
      await assert.rejects(() => svc.unresolved(oneTask, { projectId: p2 }), (e: unknown) => e instanceof DomainError && e.code === "not_found");
      await assert.rejects(() => svc.unresolved(far), (e: unknown) => e instanceof DomainError && e.code === "invalid_command");
      // The escalated defect is answered from the Needs-you list (needs-you.answer, kind defect): only the owner, never an agent or a task credential.
      const answer = OPERATIONS.find((o) => o.name === "needs-you.answer")!;
      const answerAs = (principal: Principal, args: Record<string, unknown>, commandId: string) => answer.run({ principal, defects: svc } as never, args as never, commandId) as Promise<{ item: Record<string, unknown> }>;
      const refusedWith = (code: string) => (e: unknown) => e instanceof DomainError && e.code === code;
      await assert.rejects(() => answerAs(rev, { kind: "defect", id: failed, answer: "accept-as-is" }, cid("na")), refusedWith("forbidden"));
      await assert.rejects(() => answerAs({ ...owner, taskScope: { taskId: t1, projectId: p1 } } as Principal, { kind: "defect", id: failed, answer: "accept-as-is" }, cid("na")), refusedWith("forbidden"));
      assert.equal(((await svc.get(owner, failed))!)["state"], "escalated", "nothing was decided by them");
      // Escalated state is read from the record: after the owner's repair-again it is open again, with the count kept; the default reason is recorded.
      const once = cid("na");
      const first = (await answerAs(owner, { kind: "defect", id: failed, answer: "repair-again" }, once)).item;
      assert.deepEqual([first["kind"], first["answer"], first["replayed"]], ["defect", "repair-again", false]);
      // The same command again (its reply lost) is answered from what it recorded; the same command ID with the other answer is refused, and so is a new answer to an item that no longer waits.
      const again = (await answerAs(owner, { kind: "defect", id: failed, answer: "repair-again" }, once)).item;
      assert.deepEqual([again["replayed"], again["overrideId"]], [true, first["overrideId"]]);
      await assert.rejects(() => answerAs(owner, { kind: "defect", id: failed, answer: "accept-as-is" }, once), refusedWith("command_conflict"));
      await assert.rejects(() => answerAs(owner, { kind: "defect", id: failed, answer: "accept-as-is" }, cid("na")), refusedWith("invalid_transition"));
      await assert.rejects(() => answerAs(owner, { kind: "defect", id: failed, answer: "maybe" }, cid("na")), refusedWith("invalid_command"));
      const decided = (await svc.get(owner, failed))!;
      assert.deepEqual([decided["state"], (decided["overrideRecords"] as { outcome: string; reason: string }[]).map((o) => [o.outcome, o.reason])], ["open", [["repair-again", "answered from the Needs-you list"]]]);
      const after2 = await svc.unresolved(owner, { projectId: p1 });
      assert.deepEqual(after2.counts, { escalated: 0, awaitingCheck: 0, open: 3 });
      assert.equal(after2.items.find((x) => x.id === failed)!.cycles, 1);
      // The item names the escalation by the defect's revision: once the defect escalated again, an answer carrying the earlier escalation's revision is refused and changes nothing; the current one is applied.
      const seenAt = (first["revision"] as number) - 1;
      const v3 = await newVersion(g1);
      await svc.repair(ann, { commandId: cid("rp"), id: failed, version: v3 });
      await svc.review(rev, { commandId: cid("rv"), id: failed, verdict: "not-fixed", reason: "still wrong again" });
      const reEscalated = (await svc.get(owner, failed))!;
      assert.deepEqual([reEscalated["state"], reEscalated["cycles"]], ["escalated", 2]);
      await assert.rejects(() => answerAs(owner, { kind: "defect", id: failed, answer: "accept-as-is", expectedRevision: seenAt }, cid("na")), refusedWith("invalid_transition"));
      await assert.rejects(() => answerAs(owner, { kind: "defect", id: failed, answer: "accept-as-is", expectedRevision: "x" }, cid("na")), refusedWith("invalid_command"));
      assert.equal(((await svc.get(owner, failed))!)["state"], "escalated", "the stale answer changed nothing");
      // The repeat of the first answer is still answered from its record, whatever revision it carries.
      assert.equal((await answerAs(owner, { kind: "defect", id: failed, answer: "repair-again", expectedRevision: seenAt }, once)).item["replayed"], true);
      const listed = (await svc.unresolved(owner, { escalatedOnly: true })).items.find((x) => x.id === failed)!;
      assert.equal(listed.revision, reEscalated["revision"]);
      const second = (await answerAs(owner, { kind: "defect", id: failed, answer: "accept-as-is", expectedRevision: listed.revision }, cid("na"))).item;
      assert.equal(second["replayed"], false);
      assert.equal(((await svc.get(owner, failed))!)["state"], "overridden");
    } finally {
      await world.close();
    }
  });
}
