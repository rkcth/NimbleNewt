import assert from "node:assert/strict";
import { after, test } from "node:test";
import { DomainError, type DomainErrorCode } from "../domain/errors.js";
import { derivedId } from "../domain/ids.js";
import { CommandRunner } from "../domain/runner.js";
import { ProjectService } from "../domain/service.js";
import { backends, stopServer } from "../domain/testing/backends.js";
import { relianceIdOf } from "../decisions/records.js";
import { PrincipalService, type Principal } from "../security/index.js";
import type { JsonObject } from "../storage/types.js";
import { QaEvidenceService } from "./index.js";

after(stopServer);

const options = { clock: () => "2026-11-18T10:00:00.000Z", pause: async () => undefined };
let n = 0;
const cid = (label: string): string => `${label}-${n++}`;
const refuses = async (code: DomainErrorCode, run: () => Promise<unknown>, match?: RegExp): Promise<void> => {
  await assert.rejects(run, (error: unknown) => { assert.ok(error instanceof DomainError, String(error)); assert.equal(error.code, code, error.message); if (match) assert.match(error.message, match); return true; });
};
const tree = "e".repeat(64);

for (const backend of backends) {
  test(`${backend.name}: QA evidence is bound to tree, criteria and decisions; a changed dependency invalidates it and schedules a re-check (card Q02)`, async () => {
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
      const runner = new CommandRunner(world.storage, projects.epoch, options);
      const plant = async (kind: string, id: string, body: object, update = false): Promise<void> => {
        const found = await runner.get(kind, id);
        await runner.command("test.plant", { commandId: cid("plant"), actor: owner.id }, async () => ({ payload: { kind, id, update }, build: async () => ({ ref: { kind, id }, creates: found === undefined, changes: [found === undefined ? { type: "create" as const, ref: { kind, id }, body: body as JsonObject } : { type: "update" as const, ref: { kind, id }, expectedRevision: found.revision, body: body as JsonObject }], detail: {} }) }));
      };
      const notices: string[] = [];
      const svc = QaEvidenceService.withEpoch(world.storage, projects.epoch, { rolesOf: async (id) => roles.get(id) ?? [], notify: async (x) => { notices.push(x.recheckId); } }, options);
      const ann = await agent("ann", ["author"]);
      const qa = await agent("qa", ["qa"]);
      const sub = derivedId("sbm", cid("sub"));
      await plant("submission", sub, { taskId: task, projectId: project, kind: "code", role: "author", submittedBy: ann.id, submittedAt: "2026-11-18T09:00:00.000Z", makesCommit: true, base: "a".repeat(40), tree, patchId: "c".repeat(40), evidence: [] });
      const contract = (v: number, criteria: string[], priority = 5) => ({ taskId: task, projectId: project, version: v, changedBy: owner.id, acceptanceCriteria: criteria, priority, budget: {}, workClass: "P", requiredEvidence: [], checks: [{ name: "unit", run: ["true"] }], permissions: [], recovery: "native-continuation" });
      await plant("task-contract", task, contract(1, ["works"]));
      await plant("task-contract-version", `${task}.1`, { ...contract(1, ["works"]), changedAt: "2026-11-18T08:00:00.000Z" });
      const dec = derivedId("dec", cid("dec"));
      const decision = (state: string) => ({ projectId: project, category: "decision", topic: "db", statement: "s", wording: "w", source: { channel: "direct" }, origin: { principalId: owner.id }, version: 1, state, supersedes: [], recordedAt: "2026-11-18T08:00:00.000Z", contextVersion: 1 });
      await plant("decision", dec, decision("active"));
      await plant("decision-reliance", relianceIdOf(task), { taskId: task, projectId: project, links: [{ id: "l1", subject: { kind: "task", id: task }, decisionId: dec, version: 1, topic: "db", state: "current", linkedBy: owner.id, linkedAt: "2026-11-18T08:00:00.000Z" }], revalidations: 0, followUps: [] });

      const ev = { submissionId: sub, criteriaRevision: 1, decisions: [dec], environment: "linux", observedAt: "2026-11-18T09:30:00.000Z", checks: [{ name: "unit", result: "passed" }] };
      assert.equal((await svc.gate(qa, sub)).verdict, "failed", "no evidence fails");
      await principals.enroll(owner, { commandId: cid("e"), kind: "agent", name: "eve", grants: [] });
      const eve = await principals.authenticate((await principals.issueCredential(owner, "agent:eve")).token);
      roles.set(eve.id, ["qa"]);
      await refuses("not_found", () => svc.record(eve, { commandId: cid("r"), ...ev }), /task/);
      await refuses("stale_revision", () => svc.record(qa, { commandId: cid("r"), ...ev, criteriaRevision: 2 }));
      const self = await svc.record(ann, { commandId: cid("r"), ...ev });
      assert.equal(self.source, "self");
      assert.equal((await svc.gate(owner, sub)).verdict, "failed", "a self-check never counts");
      const rec = await svc.record(qa, { commandId: "q-one", ...ev, checks: [{ name: "unit", result: "blocked" }, { name: "lint", result: "not-run" }] });
      assert.deepEqual((await svc.gate(owner, sub)).counts, { passed: 0, failed: 0, blocked: 1, notRun: 0, missing: 0 }, "only the required checks are judged; blocked is kept apart");
      const ok = await svc.record(qa, { commandId: "q-two", ...ev });
      assert.equal((await svc.gate(owner, sub)).verdict, "passed");
      void rec;

      // A new priority: nothing stale. New acceptance criteria: stale, invalidated, re-check scheduled and told.
      await plant("task-contract", task, contract(2, ["works"], 9), true);
      await plant("task-contract-version", `${task}.2`, { ...contract(2, ["works"], 9), changedAt: "2026-11-18T09:40:00.000Z" });
      assert.deepEqual((await svc.check(owner, { commandId: cid("k"), taskId: task })).invalidated, []);
      await plant("task-contract", task, contract(3, ["works", "is fast"], 9), true);
      await plant("task-contract-version", `${task}.3`, { ...contract(3, ["works", "is fast"], 9), changedAt: "2026-11-18T09:50:00.000Z" });
      const k = await svc.check(qa, { commandId: cid("k"), taskId: task });
      assert.equal(k.invalidated.length, 3, "every current record of the task that no longer holds, the self-check too");
      assert.deepEqual(notices, k.rechecks);
      assert.equal((await svc.gate(owner, sub)).verdict, "failed");
      const listed = await svc.list(owner, task);
      assert.ok(listed.items.every((i) => i.state === "invalidated"));
      assert.equal(listed.rechecks.filter((r) => r.state === "pending").length, 3);
      const again = await svc.record(qa, { commandId: cid("r"), ...ev, criteriaRevision: 3 });
      assert.equal(again.settled.length, 3, "independent evidence on the submission settles its re-checks");
      assert.equal((await svc.gate(owner, sub)).verdict, "passed");

      // The decision is superseded: the gate fails and the evidence goes stale.
      await plant("decision", dec, decision("superseded"), true);
      const g = await svc.gate(owner, sub);
      assert.deepEqual([g.verdict, g.stale.some((s) => s.id === again.id && s.reasons[0]!.kind === "decision_superseded")], ["failed", true]);
      await refuses("invalid_command", () => svc.record(qa, { commandId: cid("r"), ...ev, criteriaRevision: 3 }), /superseded|is superseded/);
      assert.equal((await svc.check(owner, { commandId: cid("k"), taskId: task })).invalidated[0], again.id);
      void ok;
    } finally { await world.close(); }
  });
}
