// Card Q02 (sixth slice): a reviewer's verdict may cite the task contract version and the owner decisions it judged against; a rejection that cites names the unmet owner requirement; a stale version, a decision not in force
// and an approval of work bound to a superseded decision are refused. A review that cites nothing is as before. Runs on all four storage backends.
import assert from "node:assert/strict";
import { after, test } from "node:test";
import { DomainError, type DomainErrorCode } from "../domain/errors.js";
import { derivedId } from "../domain/ids.js";
import { relianceIdOf } from "../decisions/records.js";
import { CommandRunner } from "../domain/runner.js";
import { ProjectService } from "../domain/service.js";
import { backends, stopServer } from "../domain/testing/backends.js";
import { PrincipalService, type Principal } from "../security/index.js";
import type { JsonObject } from "../storage/types.js";
import { SubmissionService } from "./index.js";

after(stopServer);

const options = { clock: () => "2026-11-22T10:00:00.000Z", pause: async () => undefined };
let n = 0;
const cid = (label: string): string => `${label}-${n++}`;
const refuses = async (code: DomainErrorCode, run: () => Promise<unknown>, match?: RegExp): Promise<void> => {
  await assert.rejects(run, (error: unknown) => { assert.ok(error instanceof DomainError, String(error)); assert.equal(error.code, code, error.message); if (match) assert.match(error.message, match); return true; });
};
const T1 = "a".repeat(40), BASE = "c".repeat(40), PATCH = "d".repeat(40);

for (const backend of backends) {
  test(`${backend.name}: a verdict that cites the criteria version and decisions is kept and answered; stale, out-of-force and mismatched citations are refused; an uncited review is as before (card Q02)`, async () => {
    const world = await backend.open();
    try {
      const projects = await ProjectService.open(world.storage, { holder: "c1", ...options });
      const principals = PrincipalService.withEpoch(world.storage, projects.epoch, options);
      const owner = await principals.authenticate((await principals.bootstrapOwner({ name: "rob" })).token);
      const project = (await projects.createProject({ commandId: cid("p"), actor: owner.id, name: "P" })).id;
      const other = (await projects.createProject({ commandId: cid("p"), actor: owner.id, name: "Q" })).id;
      const task = (await projects.createTask({ commandId: cid("t"), actor: owner.id, projectId: project, title: "T" })).id;
      const roles = new Map<string, string[]>();
      const agent = async (nm: string, held: string[], read = true): Promise<Principal> => {
        await principals.enroll(owner, { commandId: cid("e"), kind: "agent", name: nm, grants: read ? [{ action: "task.read", project }] : [] });
        const p = await principals.authenticate((await principals.issueCredential(owner, `agent:${nm}`)).token);
        roles.set(p.id, held);
        return p;
      };
      const svc = SubmissionService.withEpoch(world.storage, projects.epoch, async (id) => roles.get(id) ?? [], options);
      const runner = new CommandRunner(world.storage, projects.epoch, options);
      const plant = async (kind: string, id: string, body: object): Promise<void> => {
        const found = await runner.get(kind, id);
        await runner.command("test.plant", { commandId: cid("plant"), actor: owner.id }, async () => ({ payload: { kind, id, body: body as JsonObject }, build: async () => ({ ref: { kind, id }, creates: found === undefined, changes: [found === undefined ? { type: "create" as const, ref: { kind, id }, body: body as JsonObject } : { type: "update" as const, ref: { kind, id }, expectedRevision: found.revision, body: body as JsonObject }], detail: {} }) }));
      };
      const raw = async (kind: string, id: string): Promise<any> => (await world.storage.getAggregate({ kind, id }))?.body;
      const decision = (state: string, projectId = project, version = 1, extra: object = {}) => ({ projectId, category: "decision", topic: "db", statement: "s", wording: "w", source: { channel: "direct" }, origin: { principalId: owner.id }, version, state, supersedes: [], recordedAt: "2026-11-22T09:05:00.000Z", contextVersion: 1, ...extra });
      const contract = { taskId: task, projectId: project, version: 2, changedBy: owner.id, acceptanceCriteria: ["works"], priority: 5, budget: {}, workClass: "P", requiredEvidence: [], checks: [], permissions: [], recovery: "native-continuation" };
      await plant("task-contract", task, contract);
      const dA = derivedId("dec", cid("d")), dB = derivedId("dec", cid("d")), dOld = derivedId("dec", cid("d")), dForeign = derivedId("dec", cid("d"));
      await plant("decision", dA, decision("active", project, 3));
      await plant("decision", dB, decision("active"));
      await plant("decision", dOld, decision("superseded", project, 1, { supersededBy: dA }));
      await plant("decision", dForeign, decision("active", other));

      const ann = await agent("ann", ["author"]);
      const rev = await agent("rev", ["reviewer"]);
      const stranger = await agent("stranger", ["reviewer"], false);
      const code = await svc.record(ann, { commandId: cid("s"), taskId: task, kind: "code", role: "author", base: BASE, tree: T1, patchId: PATCH });
      const review = (who: Principal, extra: object, commandId = cid("rv")) => svc.record(who, { commandId, taskId: task, kind: "review", role: "reviewer", subject: code.id, ...extra } as never);

      // An uncited review is as before: nothing extra is stored or answered.
      const plain = await review(rev, { verdict: "approve" });
      assert.deepEqual(Object.keys(await raw("submission", plain.id)).filter((k) => ["criteriaRevision", "decisions", "decisionVersions", "unmet"].includes(k)), []);
      const first = await svc.approvalOf(code.id);
      assert.equal(first?.approved, true);
      assert.equal("cited" in (first ?? {}), false);
      assert.equal((await raw("submission-verdicts", code.id)).reviews[0].cited, undefined);

      // A cited approval is kept with the review and answered with the version of each decision.
      const cited = await review(rev, { verdict: "approve", criteriaRevision: 2, decisions: [dA, dB] });
      const stored = await raw("submission", cited.id);
      assert.deepEqual([stored.criteriaRevision, stored.decisions, stored.decisionVersions], [2, [dA, dB], { [dA]: 3, [dB]: 1 }]);
      assert.deepEqual((await svc.approvalOf(code.id))?.cited, { criteriaRevision: 2, decisions: [{ id: dA, version: 3 }, { id: dB, version: 1 }] });
      // A repeat of the same command records once, even after the contract moved on.
      const same = { verdict: "approve", criteriaRevision: 2, decisions: [dA] };
      const once = await review(rev, same, "fixed-id");
      await plant("task-contract", task, { ...contract, version: 3 });
      const repeat = await review(rev, same, "fixed-id");
      assert.deepEqual([repeat.id, repeat.replayed], [once.id, true]);
      await plant("task-contract", task, contract);

      // Refusals. Nothing is recorded by any of them.
      const verdictsBefore = (await raw("submission-verdicts", code.id)).reviews.length;
      await refuses("stale_revision", () => review(rev, { verdict: "approve", criteriaRevision: 1, decisions: [] }), /version 2, not 1/);
      await refuses("stale_revision", () => review(rev, { verdict: "approve", criteriaRevision: 3 }));
      await refuses("invalid_command", () => review(rev, { verdict: "approve", decisions: [dA] }), /criteriaRevision/);
      await refuses("invalid_command", () => review(rev, { verdict: "reject", unmet: "no tests" }), /criteriaRevision/);
      await refuses("invalid_command", () => review(rev, { verdict: "changes", criteriaRevision: 2, unmet: "no tests" }), /only a rejection/);
      await refuses("invalid_command", () => review(rev, { verdict: "approve", criteriaRevision: 2, unmet: "x" }), /only a rejection/);
      await refuses("invalid_command", () => review(rev, { verdict: "reject", criteriaRevision: 2 }), /names the owner requirement/);
      await refuses("invalid_command", () => review(rev, { verdict: "reject", criteriaRevision: 2, unmet: "" }));
      await refuses("invalid_command", () => review(rev, { verdict: "reject", criteriaRevision: 2, unmet: "x".repeat(501) }));
      await refuses("invalid_command", () => review(rev, { verdict: "reject", criteriaRevision: 2, unmet: 5 }));
      await refuses("invalid_command", () => review(rev, { verdict: "approve", criteriaRevision: -1 }));
      await refuses("invalid_command", () => review(rev, { verdict: "approve", criteriaRevision: 1.5 }));
      await refuses("invalid_command", () => review(rev, { verdict: "approve", criteriaRevision: "2" }));
      await refuses("invalid_command", () => review(rev, { verdict: "approve", criteriaRevision: 2, decisions: [dA, dA] }));
      await refuses("invalid_command", () => review(rev, { verdict: "approve", criteriaRevision: 2, decisions: ["nope"] }));
      await refuses("invalid_command", () => review(rev, { verdict: "approve", criteriaRevision: 2, decisions: "dec" }));
      await refuses("invalid_command", () => review(rev, { verdict: "approve", criteriaRevision: 2, decisions: Array.from({ length: 21 }, (_, i) => derivedId("dec", `x${i}`)) }));
      await refuses("invalid_command", () => review(rev, { verdict: "approve", criteriaRevision: 2, decisions: [derivedId("dec", "missing")] }), /not a decision of this task or its project/);
      await refuses("invalid_command", () => review(rev, { verdict: "approve", criteriaRevision: 2, decisions: [dForeign] }), /not a decision of this task or its project/);
      await refuses("invalid_command", () => review(rev, { verdict: "approve", criteriaRevision: 2, decisions: [dOld] }), new RegExp(`current one is ${dA}`));
      assert.equal((await raw("submission-verdicts", code.id)).reviews.length, verdictsBefore, "a refused verdict records nothing");

      // A task relying on decisions: an approval names every one and is refused while one was superseded; a rejection is still allowed.
      const link = (id: string, state: string) => ({ id: `l-${id}`, subject: { kind: "task", id: task }, decisionId: id, version: 1, topic: "db", state, linkedBy: owner.id, linkedAt: "2026-11-22T09:06:00.000Z" });
      await plant("decision-reliance", relianceIdOf(task), { taskId: task, projectId: project, links: [link(dB, "current")], revalidations: 0, followUps: [] });
      await refuses("invalid_command", () => review(rev, { verdict: "approve", criteriaRevision: 2, decisions: [dA] }), new RegExp(`relies on decision ${dB}: name it`));
      await review(rev, { verdict: "approve", criteriaRevision: 2, decisions: [dB] });
      const rejected = await review(rev, { verdict: "reject", criteriaRevision: 2, decisions: [dA], unmet: "decision db: the parser must keep the old format" });
      assert.deepEqual((await svc.approvalOf(code.id))?.cited, { criteriaRevision: 2, decisions: [{ id: dA, version: 3 }], unmet: "decision db: the parser must keep the old format" });
      assert.equal((await svc.approvalOf(code.id))?.approved, false);
      assert.equal((await svc.approvalOf(code.id))?.newest, "reject");
      await plant("decision-reliance", relianceIdOf(task), { taskId: task, projectId: project, links: [link(dB, "superseded")], revalidations: 0, followUps: [] });
      await refuses("invalid_command", () => review(rev, { verdict: "approve", criteriaRevision: 2, decisions: [dB] }), /which was superseded/);
      await refuses("invalid_command", () => review(rev, { verdict: "approve", criteriaRevision: 2, decisions: [] }), /which was superseded/);
      const changes = await review(rev, { verdict: "changes", criteriaRevision: 2, decisions: [dB] });
      assert.equal(typeof changes.id, "string");
      assert.deepEqual((await svc.approvalOf(code.id))?.cited, { criteriaRevision: 2, decisions: [{ id: dB, version: 1 }] }, "the newest review decides what is answered");
      // An uncited approval of the same work is still accepted as before (no citation, no check).
      const old = await review(rev, { verdict: "approve" });
      assert.equal((await svc.approvalOf(code.id))?.approved, true);
      assert.equal("cited" in ((await svc.approvalOf(code.id)) ?? {}), false);
      assert.ok(old.id !== rejected.id);

      // Access rules hold as before: an agent that cannot read the task finds no such task; the author never reviews its own work; a code or qa submission carries no citation.
      await refuses("not_found", () => review(stranger, { verdict: "approve", criteriaRevision: 2 }));
      roles.set(ann.id, ["author", "reviewer"]);
      await refuses("forbidden", () => review(ann, { verdict: "approve", criteriaRevision: 2 }));
      await refuses("invalid_command", () => svc.record(ann, { commandId: cid("s"), taskId: task, kind: "code", role: "author", base: BASE, tree: T1, patchId: PATCH, criteriaRevision: 2 } as never), /does not carry criteriaRevision/);
      roles.set(rev.id, ["reviewer", "qa"]);
      await refuses("invalid_command", () => svc.record(rev, { commandId: cid("q"), taskId: task, kind: "qa", role: "qa", subject: code.id, report: "ok", unmet: "x" } as never), /carries no unmet/);
    } finally { await world.close(); }
  });
}
