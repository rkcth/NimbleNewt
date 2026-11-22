import assert from "node:assert/strict";
import { after, test } from "node:test";
import { OPERATIONS } from "../api/operations.js";
import { DomainError } from "../domain/errors.js";
import { derivedId } from "../domain/ids.js";
import { relianceIdOf } from "../decisions/records.js";
import { CommandRunner } from "../domain/runner.js";
import { ProjectService } from "../domain/service.js";
import { backends, stopServer } from "../domain/testing/backends.js";
import { PrincipalService, type Principal } from "../security/index.js";
import type { JsonObject } from "../storage/types.js";
import { QaEvidenceService, decisionChangeHook } from "./index.js";

after(stopServer);

const options = { clock: () => "2026-11-22T10:00:00.000Z", pause: async () => undefined };
let n = 0;
const cid = (label: string): string => `${label}-${n++}`;
const tree = "e".repeat(64);

// Card Q02 fifth slice: a decision change that reaches a task looks at the task's QA evidence without anyone asking (QaEvidenceService.decisionChanged, which the decision service's hook calls).
for (const backend of backends) {
  test(`${backend.name}: a superseded or disputed decision invalidates the QA evidence citing it by itself, once; a repeat, an unrelated task and a missing task write nothing (card Q02)`, async () => {
    const world = await backend.open();
    try {
      const projects = await ProjectService.open(world.storage, { holder: "c1", ...options });
      const principals = PrincipalService.withEpoch(world.storage, projects.epoch, options);
      const owner = await principals.authenticate((await principals.bootstrapOwner({ name: "rob" })).token);
      const project = (await projects.createProject({ commandId: cid("p"), actor: owner.id, name: "P" })).id;
      const task = (await projects.createTask({ commandId: cid("t"), actor: owner.id, projectId: project, title: "T" })).id;
      const idle = (await projects.createTask({ commandId: cid("t"), actor: owner.id, projectId: project, title: "No evidence" })).id;
      await principals.enroll(owner, { commandId: cid("e"), kind: "agent", name: "qa", grants: [{ action: "task.read", project }] });
      const qa: Principal = await principals.authenticate((await principals.issueCredential(owner, "agent:qa")).token);
      const runner = new CommandRunner(world.storage, projects.epoch, options);
      const plant = async (kind: string, id: string, body: object): Promise<void> => {
        const found = await runner.get(kind, id);
        await runner.command("test.plant", { commandId: cid("plant"), actor: owner.id }, async () => ({ payload: { kind, id }, build: async () => ({ ref: { kind, id }, creates: found === undefined, changes: [found === undefined ? { type: "create" as const, ref: { kind, id }, body: body as JsonObject } : { type: "update" as const, ref: { kind, id }, expectedRevision: found.revision, body: body as JsonObject }], detail: {} }) }));
      };
      const notices: string[] = [];
      const invalidatedPort: string[][] = [];
      const svc = QaEvidenceService.withEpoch(world.storage, projects.epoch, { rolesOf: async () => ["qa"], // Like the controller: one notice per notice ID, and a documentation check keyed by evidence (a repeat of a check sends its follow-ups again, card Q03 slice 8).
        notify: async (x) => { if (!notices.includes(x.recheckId)) notices.push(x.recheckId); }, invalidated: async (e) => { const key = e.evidence.map((x) => x.evidenceId); if (!invalidatedPort.some((k) => k.join() === key.join())) invalidatedPort.push(key); } }, options);
      const sub = derivedId("sbm", cid("sub"));
      await plant("submission", sub, { taskId: task, projectId: project, kind: "code", role: "author", submittedBy: "agent:ann", submittedAt: "2026-11-22T09:00:00.000Z", makesCommit: true, base: "a".repeat(40), tree, patchId: "c".repeat(40), evidence: [] });
      const contract = { taskId: task, projectId: project, version: 1, changedBy: owner.id, acceptanceCriteria: ["works"], priority: 5, budget: {}, workClass: "P", requiredEvidence: [], checks: [{ name: "unit", run: ["true"] }], permissions: [], recovery: "native-continuation" };
      await plant("task-contract", task, contract);
      await plant("task-contract-version", `${task}.1`, { ...contract, changedAt: "2026-11-22T09:10:00.000Z" });
      const dec = derivedId("dec", cid("dec"));
      const decision = (state: string, version = 1) => ({ projectId: project, category: "decision", topic: "db", statement: "s", wording: "w", source: { channel: "direct" }, origin: { principalId: owner.id }, version, state, supersedes: [], recordedAt: "2026-11-22T09:05:00.000Z", contextVersion: 1 });
      await plant("decision", dec, decision("active"));
      await plant("decision-reliance", relianceIdOf(task), { taskId: task, projectId: project, links: [{ id: "l1", subject: { kind: "task", id: task }, decisionId: dec, version: 1, topic: "db", state: "current", linkedBy: owner.id, linkedAt: "2026-11-22T09:06:00.000Z" }], revalidations: 0, followUps: [] });

      // No evidence yet, a task that does not exist, a task with none: answered, nothing written.
      assert.deepEqual(await svc.decisionChanged(task), { taskId: task, invalidated: [], rechecks: [] });
      assert.deepEqual((await svc.decisionChanged("task-" + "a".repeat(20))).invalidated, []);
      assert.deepEqual((await svc.decisionChanged(idle)).invalidated, []);

      const rec = await svc.record(qa, { commandId: cid("r"), submissionId: sub, criteriaRevision: 1, decisions: [dec], environment: "linux", observedAt: "2026-11-22T09:30:00.000Z", checks: [{ name: "unit", result: "passed" }] });
      assert.equal((await svc.gate(owner, sub)).verdict, "passed");
      // The decision still stands: nothing is stale, nothing written.
      assert.deepEqual((await svc.decisionChanged(task)).invalidated, []);
      assert.equal((await svc.list(owner, task)).items[0]!.state, "current");

      // The owner corrects the decision: the evidence is invalidated at once, re-check for the recorder, owner told once, port told once.
      await plant("decision", dec, decision("superseded"));
      const first = await svc.decisionChanged(task);
      assert.deepEqual([first.invalidated, first.rechecks], [[rec.id], [derivedId("qrc", rec.id)]]);
      const listed = await svc.list(owner, task);
      assert.deepEqual([listed.items[0]!.state, listed.items[0]!.reasons?.[0]?.kind, listed.rechecks[0]!.assignee, listed.rechecks[0]!.requestedBy], ["invalidated", "decision_superseded", qa.id, "service:qa-evidence"]);
      assert.deepEqual([notices, invalidatedPort], [[derivedId("qrc", rec.id)], [[rec.id]]]);
      // The same notice again writes and tells nothing more.
      const repeat = await svc.decisionChanged(task);
      assert.deepEqual([repeat.invalidated, repeat.rechecks, notices.length, invalidatedPort.length], [[], [], 1, 1]);
      assert.equal((await svc.list(owner, task)).rechecks.length, 1);

      // A dispute is a change too: evidence cited against a decision that is now disputed is invalidated by the next notice (the repeat above did not use up the command ID).
      const dec2 = derivedId("dec", cid("dec"));
      await plant("decision", dec2, decision("active"));
      await plant("decision-reliance", relianceIdOf(task), { taskId: task, projectId: project, links: [{ id: "l2", subject: { kind: "task", id: task }, decisionId: dec2, version: 1, topic: "db2", state: "current", linkedBy: owner.id, linkedAt: "2026-11-22T09:36:00.000Z" }], revalidations: 1, followUps: [] });
      const again = await svc.record(qa, { commandId: cid("r"), submissionId: sub, criteriaRevision: 1, decisions: [dec2], environment: "linux", observedAt: "2026-11-22T09:40:00.000Z", checks: [{ name: "unit", result: "passed" }] });
      await plant("decision", dec2, decision("disputed"));
      const second = await svc.decisionChanged(task);
      assert.deepEqual(second.invalidated, [again.id]);
      assert.equal((await svc.list(owner, task)).items.find((i) => i.id === again.id)!.reasons?.[0]?.kind, "decision_superseded");
      assert.equal((await svc.list(owner, task)).items.find((i) => i.id === again.id)!.state, "invalidated");

      // Two notices at once (the decision service's pass and a retry of it): invalidated once, one re-check, neither fails.
      const dec3 = derivedId("dec", cid("dec"));
      await plant("decision", dec3, decision("active"));
      await plant("decision-reliance", relianceIdOf(task), { taskId: task, projectId: project, links: [{ id: "l3", subject: { kind: "task", id: task }, decisionId: dec3, version: 1, topic: "db3", state: "current", linkedBy: owner.id, linkedAt: "2026-11-22T09:46:00.000Z" }], revalidations: 2, followUps: [] });
      const third = await svc.record(qa, { commandId: cid("r"), submissionId: sub, criteriaRevision: 1, decisions: [dec3], environment: "linux", observedAt: "2026-11-22T09:50:00.000Z", checks: [{ name: "unit", result: "passed" }] });
      await plant("decision", dec3, decision("superseded"));
      const both = await Promise.all([svc.decisionChanged(task), svc.decisionChanged(task)]);
      for (const r of both) assert.ok(r.invalidated.every((id) => id === third.id), JSON.stringify(both));
      assert.ok(both.some((r) => r.invalidated.length === 1), JSON.stringify(both));
      assert.equal((await svc.list(owner, task)).rechecks.filter((r) => r.evidenceId === third.id).length, 1);
      assert.equal(notices.filter((x) => x === derivedId("qrc", third.id)).length, 1);
    } finally { await world.close(); }
  });
  test(`${backend.name}: two tasks whose cited decision was superseded, with evidence indexes at the same revision, each have their own evidence invalidated (the automatic command ID names the task) (card Q02)`, async () => {
    const world = await backend.open();
    try {
      const projects = await ProjectService.open(world.storage, { holder: "c1", ...options });
      const principals = PrincipalService.withEpoch(world.storage, projects.epoch, options);
      const owner = await principals.authenticate((await principals.bootstrapOwner({ name: "rob" })).token);
      const project = (await projects.createProject({ commandId: cid("p"), actor: owner.id, name: "P" })).id;
      await principals.enroll(owner, { commandId: cid("e"), kind: "agent", name: "qa", grants: [{ action: "task.read", project }] });
      const qa: Principal = await principals.authenticate((await principals.issueCredential(owner, "agent:qa")).token);
      const runner = new CommandRunner(world.storage, projects.epoch, options);
      const plant = async (kind: string, id: string, body: object): Promise<void> => {
        const found = await runner.get(kind, id);
        await runner.command("test.plant", { commandId: cid("plant"), actor: owner.id }, async () => ({ payload: { kind, id }, build: async () => ({ ref: { kind, id }, creates: found === undefined, changes: [found === undefined ? { type: "create" as const, ref: { kind, id }, body: body as JsonObject } : { type: "update" as const, ref: { kind, id }, expectedRevision: found.revision, body: body as JsonObject }], detail: {} }) }));
      };
      const svc = QaEvidenceService.withEpoch(world.storage, projects.epoch, { rolesOf: async () => ["qa"] }, options);
      const contract = (task: string, v: number, criteria: string[]) => ({ taskId: task, projectId: project, version: v, changedBy: owner.id, acceptanceCriteria: criteria, priority: 5, budget: {}, workClass: "P", requiredEvidence: [], checks: [{ name: "unit", run: ["true"] }], permissions: [], recovery: "native-continuation" });
      const set = async (task: string, v: number, criteria: string[]): Promise<void> => { await plant("task-contract", task, contract(task, v, criteria)); await plant("task-contract-version", `${task}.${v}`, { ...contract(task, v, criteria), changedAt: "2026-11-22T09:10:00.000Z" }); };
      const dec = derivedId("dec", cid("dec"));
      const decision = (state: string) => ({ projectId: project, category: "decision", topic: "db", statement: "s", wording: "w", source: { channel: "direct" }, origin: { principalId: owner.id }, version: 1, state, supersedes: [], recordedAt: "2026-11-22T09:05:00.000Z", contextVersion: 1 });
      await plant("decision", dec, decision("active"));
      const evidence: { task: string; id: string }[] = [];
      for (const title of ["A", "B"]) {
        const task = (await projects.createTask({ commandId: cid("t"), actor: owner.id, projectId: project, title })).id;
        const sub = derivedId("sbm", cid("sub"));
        await plant("submission", sub, { taskId: task, projectId: project, kind: "code", role: "author", submittedBy: "agent:ann", submittedAt: "2026-11-22T09:00:00.000Z", makesCommit: true, base: "a".repeat(40), tree, patchId: "c".repeat(40), evidence: [] });
        await set(task, 1, ["works"]);
        await plant("decision-reliance", relianceIdOf(task), { taskId: task, projectId: project, links: [{ id: "l1", subject: { kind: "task", id: task }, decisionId: dec, version: 1, topic: "db", state: "current", linkedBy: owner.id, linkedAt: "2026-11-22T09:06:00.000Z" }], revalidations: 0, followUps: [] });
        const rec = await svc.record(qa, { commandId: cid("r"), submissionId: sub, criteriaRevision: 1, decisions: [dec], environment: "linux", observedAt: "2026-11-22T09:30:00.000Z", checks: [{ name: "unit", result: "passed" }] });
        evidence.push({ task, id: rec.id });
      }
      const [a, b] = evidence as [{ task: string; id: string }, { task: string; id: string }];
      assert.equal((await runner.get("qa-evidence-index", a.task))!.revision, (await runner.get("qa-evidence-index", b.task))!.revision, "both indexes at the same revision: only the task tells the two automatic checks apart");
      await plant("decision", dec, decision("superseded"));
      assert.deepEqual((await svc.decisionChanged(a.task)).invalidated, [a.id]);
      assert.deepEqual((await svc.decisionChanged(b.task)).invalidated, [b.id], "the second task's check is its own, not a replay of (or a conflict with) the first's");
      for (const e of evidence) assert.equal((await svc.list(owner, e.task)).items[0]!.state, "invalidated");
    } finally { await world.close(); }
  });
}

test("the decision hook is the one the controller uses: it tells the QA service the task, reads the service when it runs, rejects while there is none (the step stays open) and a failing check never throws (card Q02)", async () => {
  const told: string[] = [];
  let service: { decisionChanged: (taskId: string) => Promise<never> } | undefined;
  const hook = decisionChangeHook(() => service as never);
  // No service yet: the hook rejects (the decision service then leaves the task's step open and looks again on its next pass), reporting nothing.
  const early: unknown[] = [];
  await assert.rejects(decisionChangeHook(() => service as never, (e) => early.push(e))("task-" + "a".repeat(20)), (e: unknown) => e instanceof DomainError && e.code === "unavailable");
  assert.equal(early.length, 0, "a service not attached yet is not a fault");
  service = { decisionChanged: async (taskId: string) => { told.push(taskId); throw new Error("QA is down"); } };
  await hook("task-" + "b".repeat(20));
  assert.deepEqual(told, ["task-" + "b".repeat(20)]);
  // With a sink, the failure is reported there (so a missed invalidation is visible), still never thrown, even when the sink itself throws.
  const seen: unknown[] = [];
  await decisionChangeHook(() => service as never, (e) => seen.push(e))("task-" + "c".repeat(20));
  assert.deepEqual(seen.map((e) => (e as Error).message), ["QA is down"]);
  await decisionChangeHook(() => service as never, () => { throw new Error("sink down"); })("task-" + "d".repeat(20));
  service = { decisionChanged: async () => undefined as never };
  await decisionChangeHook(() => service as never, (e) => seen.push(e))("task-" + "e".repeat(20));
  assert.equal(seen.length, 1, "a check that works reports nothing");
});
