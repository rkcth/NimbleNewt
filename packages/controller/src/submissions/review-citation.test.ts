// Card Q02 (sixth slice): a reviewer's verdict may cite the task contract version and the owner decisions it judged against; a rejection that cites names the unmet owner requirement; a stale version, a decision not in force
// and an approval of work bound to a superseded decision (cited or not) are refused. A review that cites nothing is otherwise as before. Runs on all four storage backends.
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
import { readApprovalReliance, readReviewCite } from "./review-citation.js";

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
      // Work bound to a superseded decision fails review whether or not the approval cites (card Q02 citing C08); a request for changes without a citation is still allowed.
      await refuses("invalid_command", () => review(rev, { verdict: "approve" }), /which was superseded/);
      const uncitedChanges = await review(rev, { verdict: "changes" });
      assert.equal("cited" in ((await svc.approvalOf(code.id)) ?? {}), false, "an uncited newest review answers no citation");
      // Before propagation marks the link, the decision itself is read: superseded or disputed refuses the approval too.
      await plant("decision-reliance", relianceIdOf(task), { taskId: task, projectId: project, links: [link(dOld, "current")], revalidations: 0, followUps: [] });
      await refuses("invalid_command", () => review(rev, { verdict: "approve" }), new RegExp(`${dOld}, which was superseded by ${dA}`));
      const dDisputed = derivedId("dec", cid("d"));
      await plant("decision", dDisputed, decision("disputed"));
      await plant("decision-reliance", relianceIdOf(task), { taskId: task, projectId: project, links: [link(dDisputed, "current")], revalidations: 0, followUps: [] });
      await refuses("invalid_command", () => review(rev, { verdict: "approve" }), /which is disputed/);
      // Revalidated against the decision in force, the uncited approval is accepted as before.
      await plant("decision-reliance", relianceIdOf(task), { taskId: task, projectId: project, links: [link(dA, "current")], revalidations: 1, followUps: [] });
      const old = await review(rev, { verdict: "approve" });
      assert.equal((await svc.approvalOf(code.id))?.approved, true);
      assert.equal("cited" in ((await svc.approvalOf(code.id)) ?? {}), false);
      assert.ok(old.id !== rejected.id && old.id !== uncitedChanges.id);
      // A dispute the owner settles by keeping the decision (it is active again, its link never marked): the refusal clears.
      await plant("decision", dDisputed, decision("active"));
      await plant("decision-reliance", relianceIdOf(task), { taskId: task, projectId: project, links: [link(dDisputed, "current")], revalidations: 0, followUps: [] });
      assert.equal(typeof (await review(rev, { verdict: "approve" })).id, "string", "a decision in force again no longer holds the approval back");
      // A relied-on decision that cannot be read refuses the approval (fail closed); a request for changes is still allowed.
      const gone = derivedId("dec", cid("gone"));
      await plant("decision-reliance", relianceIdOf(task), { taskId: task, projectId: project, links: [link(gone, "current")], revalidations: 0, followUps: [] });
      await refuses("invalid_command", () => review(rev, { verdict: "approve" }), new RegExp(`${gone}, which cannot be read`));
      assert.equal(typeof (await review(rev, { verdict: "changes" })).id, "string");
      // A correction or a new link that lands between the approval's reads and its write makes the write lose; it is built again from what is now stored and refused.
      await plant("decision-reliance", relianceIdOf(task), { taskId: task, projectId: project, links: [link(dA, "current")], revalidations: 1, followUps: [] });
      let racing: (() => Promise<void>) | undefined;
      const store = world.storage;
      const hooked = new Proxy(store, { get(target, key) {
        if (key === "applyOperation") return async (input: { audit: readonly { type: string }[] }) => { const go = racing; if (go !== undefined && input.audit[0]?.type === "submission.record") { racing = undefined; await go(); } return (target.applyOperation as (i: unknown) => Promise<unknown>).call(target, input); };
        const v = (target as unknown as Record<PropertyKey, unknown>)[key];
        return typeof v === "function" ? (v as (...a: unknown[]) => unknown).bind(target) : v;
      } });
      const raced = SubmissionService.withEpoch(hooked, projects.epoch, async (id) => roles.get(id) ?? [], options);
      const racedReview = (extra: object) => raced.record(rev, { commandId: cid("rv"), taskId: task, kind: "review", role: "reviewer", subject: code.id, ...extra } as never);
      racing = () => plant("decision", dA, decision("superseded", project, 3, { supersededBy: dB }));
      await refuses("invalid_command", () => racedReview({ verdict: "approve" }), new RegExp(`${dA}, which was superseded by ${dB}`));
      assert.equal(racing, undefined, "the correction landed during the write");
      await plant("decision", dA, decision("active", project, 3));
      racing = () => plant("decision-reliance", relianceIdOf(task), { taskId: task, projectId: project, links: [link(dA, "current"), link(dB, "current")], revalidations: 1, followUps: [] });
      await refuses("invalid_command", () => racedReview({ verdict: "approve", criteriaRevision: 2, decisions: [dA] }), new RegExp(`relies on decision ${dB}: name it`));
      assert.equal(racing, undefined, "the new link landed during the write");
      await plant("decision-reliance", relianceIdOf(task), { taskId: task, projectId: project, links: [link(dA, "current")], revalidations: 1, followUps: [] });
      // The write is ordered against a contract change, a new link or a correction: the reads come back as revision checks.
      const reads = await readReviewCite(runner, { projectId: project, taskId: task }, { criteriaRevision: 2, decisions: [dA] });
      assert.deepEqual(reads.changes.map((c) => `${c.ref.kind}/${c.ref.id}`), [`task-contract/${task}`, `decision/${dA}`]);
      assert.deepEqual((await readApprovalReliance(runner, task, undefined)).changes.map((c) => `${c.ref.kind}/${c.ref.id}`), [`decision-reliance/${relianceIdOf(task)}`, `decision/${dA}`]);

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
