// Card Q02 leftovers: (1) no team vote or majority of agents makes a review pass over an owner decision; (2) a project review policy can REQUIRE verdicts to cite the criteria; (3) QA evidence and a reviewer
// verdict carry over to a later submission only by an unchanged patch ID. All through the real submission, QA and policy services, on all four storage backends.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { after, test } from "node:test";
import { DomainError } from "../domain/errors.js";
import { derivedId } from "../domain/ids.js";
import { relianceIdOf } from "../decisions/records.js";
import { CommandRunner } from "../domain/runner.js";
import { ProjectService } from "../domain/service.js";
import { backends, stopServer } from "../domain/testing/backends.js";
import { PrincipalService, type Principal } from "../security/index.js";
import type { JsonObject } from "../storage/types.js";
import { QaEvidenceService, QaReviewService, SubmissionService } from "./index.js";

after(stopServer);

let n = 0;
const cid = (label: string): string => `${label}-${n++}`;
const T0 = Date.parse("2026-11-23T10:00:00.000Z");
const refuses = async (code: string, run: () => Promise<unknown>, match?: RegExp): Promise<void> => {
  await assert.rejects(run, (error: unknown) => { assert.ok(error instanceof DomainError, String(error)); assert.equal(error.code, code, (error as Error).message); if (match) assert.match((error as Error).message, match); return true; });
};
const BASE = "a".repeat(40), BASE2 = "b".repeat(40), P1 = "c".repeat(40), P2 = "d".repeat(40);
const tree = (c: string): string => c.repeat(40);

async function world(open: () => Promise<{ storage: import("../storage/types.js").ControllerStorage; close(): Promise<void> }>) {
  const w = await open();
  let now = T0;
  const clock = (): string => new Date(now).toISOString();
  const options = { clock, pause: async () => undefined };
  const projects = await ProjectService.open(w.storage, { holder: "c1", ...options });
  const epoch = projects.epoch;
  const principals = PrincipalService.withEpoch(w.storage, epoch, options);
  const owner = await principals.authenticate((await principals.bootstrapOwner({ name: "rob" })).token);
  const project = (await projects.createProject({ commandId: cid("p"), actor: owner.id, name: "P" })).id;
  const roles = new Map<string, string[]>();
  const agent = async (nm: string, held: string[]): Promise<Principal> => {
    await principals.enroll(owner, { commandId: cid("e"), kind: "agent", name: nm, grants: [{ action: "task.read", project }] as never });
    const p = await principals.authenticate((await principals.issueCredential(owner, `agent:${nm}`)).token);
    roles.set(p.id, held);
    return p;
  };
  const runner = new CommandRunner(w.storage, epoch, options);
  const plant = async (kind: string, id: string, body: object): Promise<void> => {
    const found = await runner.get(kind, id);
    await runner.command("test.plant", { commandId: cid("plant"), actor: owner.id }, async () => ({ payload: { kind, id, body: body as JsonObject }, build: async () => ({ ref: { kind, id }, creates: found === undefined, changes: [found === undefined ? { type: "create" as const, ref: { kind, id }, body: body as JsonObject } : { type: "update" as const, ref: { kind, id }, expectedRevision: found.revision, body: body as JsonObject }], detail: {} }) }));
  };
  const submissions: SubmissionService = SubmissionService.withEpoch(w.storage, epoch, async (id) => roles.get(id) ?? [], { ...options, citationRequired: async (p, t) => review.requiresCitation(p, t) });
  const qa: QaEvidenceService = QaEvidenceService.withEpoch(w.storage, epoch, { rolesOf: async (id) => roles.get(id) ?? [], carriedFrom: (id) => submissions.carriedFrom(id) }, options);
  const review: QaReviewService = QaReviewService.withEpoch(w.storage, epoch, qa, { reviewers: async () => [] }, options);
  const task = async (workClass: "P" | "PC" = "P"): Promise<string> => {
    const id = (await projects.createTask({ commandId: cid("t"), actor: owner.id, projectId: project, title: "T" })).id;
    await plant("task-contract", id, { taskId: id, projectId: project, version: 1, changedBy: owner.id, acceptanceCriteria: ["works"], priority: 5, budget: {}, workClass, requiredEvidence: [], checks: [{ name: "unit", run: ["true"] }], permissions: [], recovery: "native-continuation" });
    await plant("task-contract-version", `${id}.1`, { taskId: id, projectId: project, version: 1, changedBy: owner.id, acceptanceCriteria: ["works"], priority: 5, budget: {}, workClass, requiredEvidence: [], checks: [{ name: "unit", run: ["true"] }], permissions: [], recovery: "native-continuation", changedAt: clock() });
    return id;
  };
  const code = async (by: Principal, taskId: string, base: string, patch: string, c: string): Promise<string> => {
    now += 1000;
    return (await submissions.record(by, { commandId: cid("s"), taskId, kind: "code", role: "author", base, tree: tree(c), patchId: patch })).id;
  };
  const rv = (by: Principal, taskId: string, subject: string, verdict: string, extra: object = {}) => { now += 1000; return submissions.record(by, { commandId: cid("rv"), taskId, kind: "review", role: "reviewer", subject, verdict, ...extra } as never); };
  const ev = (by: Principal, submissionId: string, extra: object = {}) => qa.record(by, { commandId: cid("q"), submissionId, criteriaRevision: 1, decisions: [], environment: "linux", observedAt: new Date(now - 500).toISOString(), checks: [{ name: "unit", result: "passed" }], ...extra } as never);
  return { w, owner, project, agent, plant, runner, submissions, qa, review, task, code, rv, ev, advance: (ms: number) => { now += ms; } };
}

for (const backend of backends) {
  test(`${backend.name}: a majority of reviewers and an adopted meeting vote cannot make a review pass over an owner decision (card Q02)`, async () => {
    const t = await world(backend.open);
    try {
      const { owner, project, agent, plant, submissions } = t;
      const taskId = await t.task();
      const ann = await agent("ann", ["author"]);
      const r1 = await agent("r1", ["reviewer"]), r2 = await agent("r2", ["reviewer"]), r3 = await agent("r3", ["reviewer"]);
      const dOld = derivedId("dec", cid("d")), dNew = derivedId("dec", cid("d"));
      const decision = (state: string, version: number, extra: object = {}) => ({ projectId: project, category: "decision", topic: "db", statement: "s", wording: "w", source: { channel: "direct" }, origin: { principalId: owner.id }, version, state, supersedes: [], recordedAt: new Date(T0).toISOString(), contextVersion: 1, ...extra });
      const link = (d: string, state: string) => ({ id: cid("l"), subject: { kind: "task", id: taskId }, decisionId: d, version: 1, topic: "db", state, linkedBy: owner.id, linkedAt: new Date(T0).toISOString() });
      await plant("decision", dOld, decision("superseded", 1, { supersededBy: dNew }));
      await plant("decision", dNew, decision("active", 2));
      await plant("decision-reliance", relianceIdOf(taskId), { taskId, projectId: project, links: [link(dOld, "superseded")], revalidations: 0, followUps: [] });
      const sub = await t.code(ann, taskId, BASE, P1, "1");
      // A meeting vote is adopted (everyone yes) to accept the work: it is a record of its own and changes nothing about the owner's decision or the review.
      await plant("meeting-decision", derivedId("mdc" as never, cid("m")), { outcome: "adopted", text: "accept the work as it is", tally: { roster: 3, yes: 3, no: 0, abstain: 0 }, projectId: project });
      // Every reviewer of the project (a majority, in fact all of them) approves: each is refused, whether or not it cites.
      for (const r of [r1, r2, r3]) {
        await refuses("invalid_command", () => t.rv(r, taskId, sub, "approve"), /superseded/);
        await refuses("invalid_command", () => t.rv(r, taskId, sub, "approve", { criteriaRevision: 1, decisions: [dNew] }), /superseded|name it/);
      }
      assert.equal((await submissions.approvalOf(sub))?.approved, false);
      // A rejection or a request for changes is still the right answer and is recorded; the newest verdict decides.
      await t.rv(r1, taskId, sub, "changes");
      assert.equal((await submissions.approvalOf(sub))?.newest, "changes");
      // Only the owner's settled decision lifts it: the reliance is current again, then the approval stands.
      await plant("decision-reliance", relianceIdOf(taskId), { taskId, projectId: project, links: [link(dNew, "current")], revalidations: 1, followUps: [] });
      await t.rv(r2, taskId, sub, "approve", { criteriaRevision: 1, decisions: [dNew] });
      assert.equal((await submissions.approvalOf(sub))?.approved, true);
      // A decision later superseded again by the owner takes the next approval away again: the vote of three more reviewers changes nothing.
      await plant("decision", dNew, decision("superseded", 2, { supersededBy: dOld }));
      await refuses("invalid_command", () => t.rv(r3, taskId, sub, "approve"), /superseded/);
    } finally { await t.w.close(); }
  });

  test(`${backend.name}: a project review policy can require verdicts to cite the criteria; owner only; scoped; shown (card Q02)`, async () => {
    const t = await world(backend.open);
    try {
      const { owner, project, agent, review, submissions } = t;
      const ann = await agent("ann", ["author"]), rev = await agent("rev", ["reviewer"]);
      const pTask = await t.task("P"), pcTask = await t.task("PC");
      const s = await t.code(ann, pTask, BASE, P1, "1");
      const spc = await t.code(ann, pcTask, BASE, P1, "2");
      assert.equal((await review.get(owner, project)).item.requireVerdictCitations, false);
      await t.rv(rev, pTask, s, "approve"); // no policy: citing is optional, as before
      await refuses("forbidden", () => review.set(ann, { commandId: cid("s"), projectId: project, requireVerdictCitations: true } as never));
      await refuses("invalid_command", () => review.set(owner, { commandId: cid("s"), projectId: project, requireVerdictCitations: "yes" } as never));
      await review.set(owner, { commandId: cid("s"), projectId: project, requireVerdictCitations: true, workClasses: ["P"] } as never);
      assert.equal((await review.get(ann, project)).item.requireVerdictCitations, true);
      assert.equal(await review.requiresCitation(project, pTask), true);
      assert.equal(await review.requiresCitation(project, pcTask), false, "a task outside the scope is not asked");
      for (const verdict of ["approve", "changes", "reject"]) await refuses("invalid_command", () => t.rv(rev, pTask, s, verdict), /requires a verdict to cite/);
      // Cited: an approval, a request for changes and a rejection that names the unmet requirement; a rejection that cites without it is refused as before.
      await t.rv(rev, pTask, s, "approve", { criteriaRevision: 1 });
      await t.rv(rev, pTask, s, "changes", { criteriaRevision: 1 });
      await refuses("invalid_command", () => t.rv(rev, pTask, s, "reject", { criteriaRevision: 1 }), /unmet/);
      await t.rv(rev, pTask, s, "reject", { criteriaRevision: 1, unmet: "the criterion 'works' is not met" });
      assert.equal((await submissions.approvalOf(s))?.cited?.unmet, "the criterion 'works' is not met");
      // Outside the scope an uncited review is accepted; switching the option off accepts it everywhere.
      await t.rv(rev, pcTask, spc, "approve");
      await review.set(owner, { commandId: cid("s"), projectId: project, requireVerdictCitations: false } as never);
      await t.rv(rev, pTask, s, "approve");
      assert.equal((await review.get(owner, project)).item.requireVerdictCitations, false);
    } finally { await t.w.close(); }
  });

  test(`${backend.name}: QA evidence and a reviewer verdict carry over to a later submission only by an unchanged patch ID (card Q02)`, async () => {
    const t = await world(backend.open);
    try {
      const { owner, agent, submissions, qa, plant, task: mk } = t;
      const taskId = await mk();
      const ann = await agent("ann", ["author"]), rev = await agent("rev", ["reviewer"]), qaAgent = await agent("qa", ["qa"]);
      const s1 = await t.code(ann, taskId, BASE, P1, "1");
      await t.ev(qaAgent, s1);
      await t.rv(rev, taskId, s1, "approve");
      assert.equal((await qa.gate(owner, s1)).verdict, "passed");
      // A rebase: new base and tree, the same patch. The evidence and the approval carry over, and the answers say where from.
      const s2 = await t.code(ann, taskId, BASE2, P1, "2");
      assert.deepEqual(await submissions.carriedFrom(s2), [s1]);
      const g2 = await qa.gate(owner, s2);
      assert.equal(g2.verdict, "passed");
      assert.deepEqual(g2.carriedFrom, [s1]);
      const a2 = await submissions.approvalOf(s2);
      assert.equal(a2?.approved, true);
      assert.equal(a2?.carriedFrom, s1);
      assert.equal((await qa.gate(owner, s1)).carriedFrom, undefined, "an earlier submission never inherits from a later one");
      assert.equal((await submissions.approvalOf(s1))?.carriedFrom, undefined);
      // Any change to the patch changes the patch ID: nothing carries over.
      const s3 = await t.code(ann, taskId, BASE2, P2, "3");
      assert.deepEqual(await submissions.carriedFrom(s3), []);
      assert.equal((await qa.gate(owner, s3)).verdict, "failed");
      assert.ok((await qa.gate(owner, s3)).reasons.includes("no_evidence"));
      assert.equal((await submissions.approvalOf(s3))?.approved, false);
      // A verdict of its own on the later submission decides there; the earlier one is not touched.
      await t.rv(rev, taskId, s2, "changes");
      assert.equal((await submissions.approvalOf(s2))?.approved, false);
      assert.equal((await submissions.approvalOf(s2))?.carriedFrom, undefined);
      assert.equal((await submissions.approvalOf(s1))?.approved, true);
      // Evidence that no longer holds does not carry: new acceptance criteria make the old evidence stale, and the rebased submission needs its own.
      const s4 = await t.code(ann, taskId, BASE2, P1, "4");
      assert.equal((await qa.gate(owner, s4)).verdict, "passed");
      t.advance(1000);
      await plant("task-contract", taskId, { taskId, projectId: t.project, version: 2, changedBy: owner.id, acceptanceCriteria: ["works", "fast"], priority: 5, budget: {}, workClass: "P", requiredEvidence: [], checks: [{ name: "unit", run: ["true"] }], permissions: [], recovery: "native-continuation" });
      const g4 = await qa.gate(owner, s4);
      assert.equal(g4.verdict, "failed");
      assert.equal(g4.carriedFrom, undefined);
      // An earlier submission of the same patch with nothing of its own does not inherit from a later one that was checked and approved.
      const taskB = await mk();
      const other = await t.code(ann, taskB, BASE2, P2, "7");
      const b1 = await t.code(ann, taskB, BASE, P1, "5");
      const b2 = await t.code(ann, taskB, BASE2, P1, "6");
      await t.ev(qaAgent, b2);
      await t.rv(rev, taskB, b2, "approve");
      assert.equal((await qa.gate(owner, b2)).verdict, "passed");
      assert.equal((await qa.gate(owner, b1)).verdict, "failed");
      assert.equal((await submissions.approvalOf(b1))?.approved, false);
      // A damaged lineage naming a submission of another patch is not believed: each entry is read again and must name the same task and patch.
      const lineage = createHash("sha256").update(`${taskB}\0${P1}`).digest("hex").slice(0, 32);
      await plant("patch-lineage", lineage, { taskId: taskB, patchId: P1, ids: [other, b1, b2] });
      assert.deepEqual(await submissions.carriedFrom(b2), [b1]);
      // A patch ID that is not a patch ID (or a document) has no lineage.
      assert.deepEqual(await submissions.carriedFrom("sbm-" + "a".repeat(20)), []);
    } finally { await t.w.close(); }
  });
}
