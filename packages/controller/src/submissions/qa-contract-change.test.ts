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
import { QaEvidenceService } from "./index.js";

after(stopServer);

const options = { clock: () => "2026-11-22T10:00:00.000Z", pause: async () => undefined };
let n = 0;
const cid = (label: string): string => `${label}-${n++}`;
const tree = "e".repeat(64);

// Card Q02 fourth slice: a changed contract looks at the task's QA evidence without anyone asking (QaEvidenceService.contractChanged, which the contract.set operation calls).
for (const backend of backends) {
  test(`${backend.name}: a contract change invalidates the QA evidence it no longer fits by itself, once, and a repeat or an unrelated change writes nothing (card Q02)`, async () => {
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
      const svc = QaEvidenceService.withEpoch(world.storage, projects.epoch, { rolesOf: async () => ["qa"], notify: async (x) => { notices.push(x.recheckId); }, invalidated: async (e) => { invalidatedPort.push(e.evidence.map((x) => x.evidenceId)); } }, options);
      const sub = derivedId("sbm", cid("sub"));
      await plant("submission", sub, { taskId: task, projectId: project, kind: "code", role: "author", submittedBy: "agent:ann", submittedAt: "2026-11-22T09:00:00.000Z", makesCommit: true, base: "a".repeat(40), tree, patchId: "c".repeat(40), evidence: [] });
      const contract = (v: number, criteria: string[], priority = 5, checks = ["unit"]) => ({ taskId: task, projectId: project, version: v, changedBy: owner.id, acceptanceCriteria: criteria, priority, budget: {}, workClass: "P", requiredEvidence: [], checks: checks.map((name) => ({ name, run: ["true"] })), permissions: [], recovery: "native-continuation" });
      const set = async (v: number, criteria: string[], priority = 5, checks = ["unit"]): Promise<void> => { await plant("task-contract", task, contract(v, criteria, priority, checks)); await plant("task-contract-version", `${task}.${v}`, { ...contract(v, criteria, priority, checks), changedAt: "2026-11-22T09:10:00.000Z" }); };
      await set(1, ["works"]);

      // No evidence yet: nothing to look at, nothing written.
      assert.deepEqual(await svc.contractChanged(task), { taskId: task, invalidated: [], rechecks: [] });
      // A task that does not exist, and one with no evidence, are answered, not thrown.
      assert.deepEqual((await svc.contractChanged("task-" + "a".repeat(20))).invalidated, []);
      assert.deepEqual((await svc.contractChanged(idle)).invalidated, []);

      const rec = await svc.record(qa, { commandId: cid("r"), submissionId: sub, criteriaRevision: 1, environment: "linux", observedAt: "2026-11-22T09:30:00.000Z", checks: [{ name: "unit", result: "passed" }] });
      assert.equal((await svc.gate(owner, sub)).verdict, "passed");

      // A change of priority is not a change of what the work must be.
      await set(2, ["works"], 9);
      assert.deepEqual((await svc.contractChanged(task)).invalidated, []);
      assert.equal((await svc.list(owner, task)).items[0]!.state, "current");

      // New acceptance criteria: invalidated at once, re-check scheduled for who recorded it, told once, the port told once.
      await set(3, ["works", "is fast"], 9);
      const first = await svc.contractChanged(task);
      assert.deepEqual([first.invalidated, first.rechecks], [[rec.id], [derivedId("qrc", rec.id)]]);
      const listed = await svc.list(owner, task);
      assert.deepEqual([listed.items[0]!.state, listed.items[0]!.reasons?.[0]?.kind, listed.rechecks[0]!.assignee, listed.rechecks[0]!.requestedBy], ["invalidated", "criteria_changed", qa.id, "service:qa-evidence"]);
      assert.deepEqual([notices, invalidatedPort], [[derivedId("qrc", rec.id)], [[rec.id]]]);

      // The same notice again (a replay of the contract change, a retry) writes and tells nothing more.
      const repeat = await svc.contractChanged(task);
      assert.deepEqual([repeat.invalidated, repeat.rechecks, notices.length, invalidatedPort.length], [[], [], 1, 1]);
      assert.equal((await svc.list(owner, task)).rechecks.length, 1);

      // New evidence on the new contract holds; a later change looks at that one, with a command ID that is not the first one's.
      const again = await svc.record(qa, { commandId: cid("r"), submissionId: sub, criteriaRevision: 3, environment: "linux", observedAt: "2026-11-22T09:40:00.000Z", checks: [{ name: "unit", result: "passed" }] });
      assert.equal((await svc.gate(owner, sub)).verdict, "passed", "evidence on the contract in force passes again");
      await set(4, ["works", "is fast"], 9, ["unit", "lint"]);
      const second = await svc.contractChanged(task);
      assert.deepEqual(second.invalidated, [again.id]);
      assert.deepEqual(notices, [derivedId("qrc", rec.id), derivedId("qrc", again.id)]);

      // Two notices of the same change at the same moment (two controllers, or a contract.set and its replay): the evidence is invalidated once, one re-check, told once, neither call fails.
      const third = await svc.record(qa, { commandId: cid("r"), submissionId: sub, criteriaRevision: 4, environment: "linux", observedAt: "2026-11-22T09:50:00.000Z", checks: [{ name: "unit", result: "passed" }, { name: "lint", result: "passed" }] });
      await set(5, ["works", "is fast", "is small"], 9, ["unit", "lint"]);
      const both = await Promise.all([svc.contractChanged(task), svc.contractChanged(task)]);
      for (const r of both) assert.ok(r.invalidated.every((id) => id === third.id), JSON.stringify(both));
      assert.ok(both.some((r) => r.invalidated.length === 1), JSON.stringify(both));
      const later = await svc.list(owner, task);
      assert.equal(later.items.find((i) => i.id === third.id)!.state, "invalidated");
      assert.equal(later.rechecks.filter((r) => r.evidenceId === third.id).length, 1);
      assert.deepEqual([notices.filter((x) => x === derivedId("qrc", third.id)).length, invalidatedPort.filter((x) => x.includes(third.id)).length], [1, 1]);

      // A record added after that change which no longer holds (the task now relies on an owner decision it was not checked against) is looked at by the same notice again at the same
      // contract version (a replayed contract.set): the command ID names the evidence index too, so the earlier check does not answer for it.
      const fourth = await svc.record(qa, { commandId: cid("r"), submissionId: sub, criteriaRevision: 5, environment: "linux", observedAt: "2026-11-22T09:55:00.000Z", checks: [{ name: "unit", result: "passed" }, { name: "lint", result: "passed" }] });
      const dec = derivedId("dec", cid("dec"));
      await plant("decision", dec, { projectId: project, category: "decision", topic: "db", statement: "s", wording: "w", source: { channel: "direct" }, origin: { principalId: owner.id }, version: 1, state: "active", supersedes: [], recordedAt: "2026-11-22T09:56:00.000Z", contextVersion: 1 });
      await plant("decision-reliance", relianceIdOf(task), { taskId: task, projectId: project, links: [{ id: "l1", subject: { kind: "task", id: task }, decisionId: dec, version: 1, topic: "db", state: "current", linkedBy: owner.id, linkedAt: "2026-11-22T09:56:00.000Z" }], revalidations: 0, followUps: [] });
      assert.deepEqual((await svc.contractChanged(task)).invalidated, [fourth.id]);

      // The automatic check and an agent's own qa.evidence.check at the same moment (different command IDs): one writes, the other answers with what was invalidated; neither fails, one re-check.
      const fifth = await svc.record(qa, { commandId: cid("r"), submissionId: sub, criteriaRevision: 5, decisions: [dec], environment: "linux", observedAt: "2026-11-22T09:57:00.000Z", checks: [{ name: "unit", result: "passed" }, { name: "lint", result: "passed" }] });
      assert.equal((await svc.gate(owner, sub)).verdict, "passed");
      await set(6, ["works", "is fast", "is small", "is safe"], 9, ["unit", "lint"]);
      const raced = await Promise.all([svc.contractChanged(task), svc.check(qa, { commandId: cid("k"), taskId: task })]);
      for (const r of raced) assert.ok(r.invalidated.every((id) => id === fifth.id), JSON.stringify(raced));
      assert.ok(raced.some((r) => r.invalidated.length === 1), JSON.stringify(raced));
      assert.equal((await svc.list(owner, task)).rechecks.filter((r) => r.evidenceId === fifth.id).length, 1);
      assert.equal(notices.filter((x) => x === derivedId("qrc", fifth.id)).length, 1);
      assert.equal((await svc.gate(owner, sub)).verdict, "failed");
    } finally { await world.close(); }
  });
}

test("contract.set tells the QA service only after the contract change is stored, never fails or changes the answer because the QA service failed, and tells nothing when the change is refused (card Q02)", async () => {
  const op = OPERATIONS.find((o) => o.name === "contract.set")!;
  const order: string[] = [];
  const principal = { id: "owner:rob", kind: "owner", name: "rob", grants: [] } as unknown as Principal;
  const contracts = { setContract: async (_by: Principal, cmd: { taskId: string }) => { order.push(`set ${cmd.taskId}`); if (cmd.taskId === "task-refused") throw new DomainError("stale_revision", "version moved"); return { id: cmd.taskId, revision: 4, replayed: false }; } };
  const failing = { contractChanged: async (taskId: string) => { order.push(`qa ${taskId}`); throw new Error("storage unavailable"); } };
  const ok = await op.run({ principal, contracts, qaEvidence: failing } as never, { taskId: "task-a", expectedVersion: 1, acceptanceCriteria: ["x"] } as never, "c1");
  assert.deepEqual(ok, { id: "task-a", revision: 4, replayed: false }, "the contract change answers as stored although the QA service failed");
  assert.deepEqual(order, ["set task-a", "qa task-a"], "the QA service is told after the change is stored, about that task");
  const laterFailing = { contractChanged: async (taskId: string) => { order.push(`qa ${taskId}`); await new Promise((r) => setImmediate(r)); throw new DomainError("integrity", "index missing"); } };
  assert.deepEqual(await op.run({ principal, contracts, qaEvidence: laterFailing } as never, { taskId: "task-b", expectedVersion: 1 } as never, "c2"), { id: "task-b", revision: 4, replayed: false });
  await assert.rejects(() => op.run({ principal, contracts, qaEvidence: failing } as never, { taskId: "task-refused", expectedVersion: 1 } as never, "c3"), (e: unknown) => e instanceof DomainError && e.code === "stale_revision");
  assert.deepEqual(order, ["set task-a", "qa task-a", "set task-b", "qa task-b", "set task-refused"], "a refused change tells the QA service nothing");
  // A controller without the QA service still changes contracts.
  assert.deepEqual(await op.run({ principal, contracts } as never, { taskId: "task-c", expectedVersion: 1 } as never, "c4"), { id: "task-c", revision: 4, replayed: false });
});
