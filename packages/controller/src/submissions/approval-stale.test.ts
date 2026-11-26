// Card Q02 (stale approvals): an approval stops counting when a decision the task relies on is superseded or disputed after it, when the task comes to rely on a decision it was not judged against, when a decision it
// cites changes, or when the task contract's work fields change. Read where approvals are read (`approvalOf`), so the landing gate's `review` check, the landing queue and the review waiting view all see it, with the
// reason in plain words. A new review against the current decisions and criteria restores it; a dispute settled by keeping the decision restores it; a priority-only contract change leaves it. Approvals recorded
// before the basis was kept are judged by their time. The carry-over by unchanged patch ID still works for unchanged decisions and stops with the same rule. Runs on all four storage backends.
import assert from "node:assert/strict";
import { after, test } from "node:test";
import { DomainError } from "../domain/errors.js";
import { derivedId } from "../domain/ids.js";
import { relianceIdOf } from "../decisions/records.js";
import { CommandRunner } from "../domain/runner.js";
import { ProjectService } from "../domain/service.js";
import { backends, stopServer } from "../domain/testing/backends.js";
import { LandingGate, type LandingCheckHost, type LandingCheckHostReport } from "../landing/landing-gate.js";
import { LandingQueueOps, LandingQueueService } from "../landing/index.js";
import { PrincipalService, type Principal } from "../security/index.js";
import type { JsonObject } from "../storage/types.js";
import { SubmissionService } from "./index.js";
import { APPROVAL_CONTRACT_WALK } from "./approval-standing.js";

after(stopServer);

const NOW = "2026-11-26T10:00:00.000Z";
const options = { clock: () => NOW, pause: async () => undefined };
let n = 0;
const cid = (label: string): string => `${label}-${n++}`;
const T1 = "a".repeat(40), T2 = "e".repeat(40), BASE = "c".repeat(40), BASE2 = "f".repeat(40), PATCH = "d".repeat(40);

for (const backend of backends) {
  test(`${backend.name}: an approval stops counting when a relied-on decision or the criteria change after it, everywhere approvals are read; a new review restores it (card Q02)`, async () => {
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
      const svc = SubmissionService.withEpoch(world.storage, projects.epoch, async (id) => roles.get(id) ?? [], options);
      const runner = new CommandRunner(world.storage, projects.epoch, options);
      const plant = async (kind: string, id: string, body: object): Promise<void> => {
        const found = await runner.get(kind, id);
        await runner.command("test.plant", { commandId: cid("plant"), actor: owner.id }, async () => ({ payload: { kind, id, body: body as JsonObject }, build: async () => ({ ref: { kind, id }, creates: found === undefined, changes: [found === undefined ? { type: "create" as const, ref: { kind, id }, body: body as JsonObject } : { type: "update" as const, ref: { kind, id }, expectedRevision: found.revision, body: body as JsonObject }], detail: {} }) }));
      };
      const raw = async (kind: string, id: string): Promise<any> => (await world.storage.getAggregate({ kind, id }))?.body;
      const decision = (state: string, version = 1, extra: object = {}) => ({ projectId: project, category: "decision", topic: "format", statement: "s", wording: "w", source: { channel: "direct" }, origin: { principalId: owner.id }, version, state, supersedes: [], recordedAt: "2026-11-26T09:00:00.000Z", contextVersion: 1, ...extra });
      const link = (id: string, state = "current", extra: object = {}) => ({ id: `l-${id}`, subject: { kind: "task", id: task }, decisionId: id, version: 1, topic: "format", state, linkedBy: owner.id, linkedAt: "2026-11-26T09:01:00.000Z", ...extra });
      const rely = (...links: object[]) => plant("decision-reliance", relianceIdOf(task), { taskId: task, projectId: project, links, revalidations: 0, followUps: [] });
      const contractBody = { taskId: task, projectId: project, changedBy: owner.id, acceptanceCriteria: ["reads old files"], priority: 5, budget: {}, workClass: "P", requiredEvidence: [], checks: [], permissions: [], recovery: "native-continuation" };
      const contract = async (version: number, extra: object = {}, changedAt = "2026-11-26T09:00:00.000Z"): Promise<void> => {
        await plant("task-contract", task, { ...contractBody, ...extra, version });
        await plant("task-contract-version", `${task}.${version}`, { ...contractBody, ...extra, version, changedAt });
      };
      await contract(1);
      const dA = derivedId("dec", cid("d")), dB = derivedId("dec", cid("d")), dC = derivedId("dec", cid("d")), dD = derivedId("dec", cid("d"));
      for (const d of [dA, dB, dC, dD]) await plant("decision", d, decision("active"));
      await rely(link(dA));

      const ann = await agent("ann", ["author"]);
      const rev = await agent("rev", ["reviewer"]);
      const code = await svc.record(ann, { commandId: cid("s"), taskId: task, kind: "code", role: "author", base: BASE, tree: T1, patchId: PATCH });
      const review = (extra: object, subject = code.id) => svc.record(rev, { commandId: cid("rv"), taskId: task, kind: "review", role: "reviewer", subject, ...extra } as never);
      const approval = () => svc.approvalOf(code.id);

      // The landing gate's `review` check and the landing queue read the same `approvalOf`.
      const host: LandingCheckHost = { landingChecks: async (call) => ({ checkout: true, change: { base: BASE, head: "9".repeat(40), tree: T1, patchId: PATCH }, checks: [], ...(call.reviewed === undefined ? {} : { reviewedPatchId: PATCH }) }) as LandingCheckHostReport };
      const gate = new LandingGate({ requiredChecks: async () => ["review"], tests: async () => undefined, approvalOf: (id) => svc.approvalOf(id), now: () => NOW });
      const reviewCheck = async () => (await gate.evaluate({ taskId: task, projectId: project, submissionId: code.id, host })).results[0]!;
      const ops = new LandingQueueOps(LandingQueueService.withEpoch(world.storage, projects.epoch, options), { approvalOf: (id) => svc.approvalOf(id), landingBranch: async () => "main", projectOfTask: async () => project });
      const queued = async () => (await ops.list(owner, { projectId: project })).items[0];
      const waitingState = async () => (await svc.waiting(owner, project)).items.find((i) => i.taskId === task)?.state;

      // 1. An approval judged against decision A and contract version 1 counts and keeps what it was judged against.
      const first = await review({ verdict: "approve" });
      assert.equal((await approval())?.approved, true);
      assert.deepEqual((await raw("submission-verdicts", code.id)).reviews[0].basis, { criteriaRevision: 1, decisions: [`${dA}@1`] });
      assert.deepEqual((await raw("submission", first.id)).judgedAgainst, { criteriaRevision: 1, decisions: [`${dA}@1`] });
      assert.equal((await reviewCheck()).result, "pass");
      assert.equal((await ops.add(owner, { commandId: cid("q"), submissionId: code.id })).position, 1);
      assert.equal((await queued())?.held, undefined);
      assert.equal(await waitingState(), "needs_signoff", "approved: it waits for a director sign-off, not for a review");

      // 2. The owner corrects decision A (superseded by B) after the approval, before propagation marks the link: the approval stops counting everywhere, with the decision, the time and what to do.
      await plant("decision", dA, decision("superseded", 1, { supersededBy: dB, supersededAt: "2026-11-26T11:00:00.000Z" }));
      const stale = await approval();
      assert.deepEqual([stale?.approved, stale?.newest, stale?.outdated?.reviewId, stale?.outdated?.approvedBy], [false, "approve", first.id, rev.id]);
      assert.equal(stale?.outdated?.because, `owner decision ${dA} was superseded by ${dB} at 2026-11-26T11:00:00.000Z`);
      assert.match(stale!.reason!, new RegExp(`^the approval by ${rev.id} at ${NOW} no longer counts: owner decision ${dA} was superseded by ${dB} at 2026-11-26T11:00:00.000Z; a reviewer has to review it again against the current decisions and criteria$`));
      const failed = await reviewCheck();
      assert.equal(failed.result, "fail", "a failing landing `review` check");
      assert.match(failed.summary, new RegExp(`${code.id} is not approved \\(the approval by ${rev.id} at .* no longer counts: owner decision ${dA} was superseded by ${dB}`));
      assert.match((await queued())!.held!, /no longer counts: owner decision .* was superseded/);
      await assert.rejects(() => ops.checkLanding(owner, { taskId: task, projectId: project, submissionId: code.id }), (e: unknown) => e instanceof DomainError && e.code === "review_invalid" && /no longer approved as queued \(the approval by .* no longer counts/.test(e.message));
      assert.equal(await waitingState(), "needs_review", "the waiting view asks for a review again, not for new work");
      // Propagation marks the link: the same.
      await rely(link(dA, "superseded", { supersededBy: dB, markedAt: "2026-11-26T11:00:01.000Z" }));
      assert.match((await approval())!.outdated!.because, new RegExp(`${dA} was superseded by ${dB}`));
      // The link's own mark is read too: a link marked superseded counts as superseded even where the decision record reads active (damaged or partly restored data).
      await plant("decision", dA, decision("active"));
      assert.equal((await approval())?.outdated?.because, `owner decision ${dA} was superseded by ${dB} at 2026-11-26T11:00:01.000Z`);
      await plant("decision", dA, decision("superseded", 1, { supersededBy: dB, supersededAt: "2026-11-26T11:00:00.000Z" }));

      // 3. The work is revalidated against B (a fresh link made after the approval): the old approval still does not count; it was given on A.
      await rely(link(dB, "current", { linkedAt: "2026-11-26T11:05:00.000Z" }));
      assert.equal((await approval())?.outdated?.because, `the task has relied on owner decision ${dB} since 2026-11-26T11:05:00.000Z, which this approval was not judged against`);
      // A new review against the current decision restores it everywhere.
      await review({ verdict: "approve" });
      assert.deepEqual([(await approval())?.approved, (await approval())?.outdated], [true, undefined]);
      assert.equal((await reviewCheck()).result, "pass");
      assert.equal((await queued())?.held, undefined);
      assert.equal((await ops.checkLanding(owner, { taskId: task, projectId: project, submissionId: code.id }))?.submissionId, code.id);
      assert.equal(await waitingState(), "needs_signoff");

      // 4. A contract change that does not touch what the work must be leaves the approval; a criteria change takes it back; a review against the new version restores it.
      await contract(2, { priority: 9 }, "2026-11-26T12:00:00.000Z");
      assert.equal((await approval())?.approved, true, "a new priority does not take an approval back");
      await contract(3, { priority: 9, acceptanceCriteria: ["reads old files", "and new files"] }, "2026-11-26T12:30:00.000Z");
      assert.equal((await approval())?.outdated?.because, "the task contract's acceptanceCriteria changed since version 1 (now version 3, stored at 2026-11-26T12:30:00.000Z)");
      assert.equal((await reviewCheck()).result, "fail");
      await review({ verdict: "approve", criteriaRevision: 3, decisions: [dB] });
      assert.equal((await approval())?.approved, true, "a cited review against the new version restores it");
      await contract(4, { priority: 9, acceptanceCriteria: ["reads old files", "and new files"], checks: [{ name: "unit", run: ["npm", "test"] }], requiredEvidence: ["report.md"] }, "2026-11-26T12:35:00.000Z");
      assert.equal((await approval())?.approved, true, "new checks or required evidence leave it: the landing's tests and qa checks judge those themselves");
      await contract(5, { priority: 9, acceptanceCriteria: ["reads old files", "and new files"], checks: [{ name: "unit", run: ["npm", "test"] }], requiredEvidence: ["report.md"], expectedResult: "both formats read" }, "2026-11-26T12:40:00.000Z");
      assert.match((await approval())!.outdated!.because, /^the task contract's expectedResult changed since version 3 \(now version 5/);
      await review({ verdict: "approve" });
      assert.equal((await approval())?.approved, true);

      // 5. A dispute over B after the approval holds it; the owner settling the dispute by keeping B restores it (nothing it was judged against changed).
      const dispute = derivedId("dsp", cid("x"));
      await plant("decision-dispute", dispute, { projectId: project, topic: "format", members: [dB, dC], state: "open", openedAt: "2026-11-26T13:00:00.000Z" });
      await plant("decision", dB, decision("disputed", 1, { disputeId: dispute }));
      assert.equal((await approval())?.outdated?.because, `owner decision ${dB} has been disputed since 2026-11-26T13:00:00.000Z (two owner instructions conflict) and waits for the owner to settle it`);
      await plant("decision", dB, decision("active"));
      assert.equal((await approval())?.approved, true, "a dispute settled by keeping the decision restores the same approval");

      // 6. A decision the task comes to rely on after the approval, a relied-on decision that cannot be read, and a cited decision that changes each take it back.
      await rely(link(dB, "current", { linkedAt: "2026-11-26T11:05:00.000Z" }), link(dC, "current", { linkedAt: "2026-11-26T14:00:00.000Z" }));
      assert.match((await approval())!.outdated!.because, new RegExp(`relied on owner decision ${dC} since 2026-11-26T14:00:00.000Z, which this approval was not judged against`));
      await rely(link(dB, "current", { linkedAt: "2026-11-26T11:05:00.000Z" }));
      assert.equal((await approval())?.approved, true, "the link taken away again: as it was judged");
      const lost = derivedId("dec", cid("lost"));
      await rely(link(dB), link(lost));
      assert.match((await approval())!.outdated!.because, new RegExp(`owner decision ${lost}, which the task relies on, cannot be read`));
      await rely(link(dB, "current", { linkedAt: "2026-11-26T11:05:00.000Z" }));
      await review({ verdict: "approve", criteriaRevision: 5, decisions: [dB, dD] });
      assert.equal((await approval())?.approved, true);
      await plant("decision", dD, decision("superseded", 1, { supersededBy: dC, supersededAt: "2026-11-26T15:00:00.000Z" }));
      assert.equal((await approval())?.outdated?.because, `owner decision ${dD} was superseded by ${dC} at 2026-11-26T15:00:00.000Z`, "a cited decision not linked to the task also counts");
      await plant("decision", dD, decision("active", 2));
      assert.equal((await approval())?.outdated?.because, `owner decision ${dD} it cites is now at version 2, not 1`);
      await plant("decision", dD, decision("active"));
      assert.equal((await approval())?.approved, true);

      // 7. Carry-over by an unchanged patch ID still works for unchanged decisions, and stops by the same rule.
      const rebased = await svc.record(ann, { commandId: cid("s"), taskId: task, kind: "code", role: "author", base: BASE2, tree: T2, patchId: PATCH });
      const carried = await svc.approvalOf(rebased.id);
      assert.deepEqual([carried?.approved, carried?.carriedFrom], [true, code.id]);
      await plant("decision", dB, decision("superseded", 1, { supersededBy: dC, supersededAt: "2026-11-26T16:00:00.000Z" }));
      const carriedStale = await svc.approvalOf(rebased.id);
      assert.deepEqual([carriedStale?.approved, carriedStale?.carriedFrom, carriedStale?.outdated?.because], [false, code.id, `owner decision ${dB} was superseded by ${dC} at 2026-11-26T16:00:00.000Z`]);
      // A rejection or a request for changes is unaffected by any of this (only approvals stop counting).
      await review({ verdict: "changes" }, rebased.id);
      assert.deepEqual([(await svc.approvalOf(rebased.id))?.newest, (await svc.approvalOf(rebased.id))?.outdated], ["changes", undefined]);
    } finally { await world.close(); }
  });

  test(`${backend.name}: an approval recorded before the basis was kept is judged by its time; past the contract walk or with a version missing it does not count (card Q02)`, async () => {
    const world = await backend.open();
    try {
      const projects = await ProjectService.open(world.storage, { holder: "c1", ...options });
      const principals = PrincipalService.withEpoch(world.storage, projects.epoch, options);
      const owner = await principals.authenticate((await principals.bootstrapOwner({ name: "rob" })).token);
      const project = (await projects.createProject({ commandId: cid("p"), actor: owner.id, name: "P" })).id;
      const task = (await projects.createTask({ commandId: cid("t"), actor: owner.id, projectId: project, title: "T" })).id;
      await principals.enroll(owner, { commandId: cid("e"), kind: "agent", name: "ann", grants: [{ action: "task.read", project }] });
      const ann = await principals.authenticate((await principals.issueCredential(owner, "agent:ann")).token);
      const svc = SubmissionService.withEpoch(world.storage, projects.epoch, async () => ["author"], options);
      const runner = new CommandRunner(world.storage, projects.epoch, options);
      const plant = async (kind: string, id: string, body: object): Promise<void> => {
        const found = await runner.get(kind, id);
        await runner.command("test.plant", { commandId: cid("plant"), actor: owner.id }, async () => ({ payload: { kind, id, body: body as JsonObject }, build: async () => ({ ref: { kind, id }, creates: found === undefined, changes: [found === undefined ? { type: "create" as const, ref: { kind, id }, body: body as JsonObject } : { type: "update" as const, ref: { kind, id }, expectedRevision: found.revision, body: body as JsonObject }], detail: {} }) }));
      };
      const code = await svc.record(ann, { commandId: cid("s"), taskId: task, kind: "code", role: "author", base: BASE, tree: T1, patchId: PATCH });
      // An approval as stored before this change: no basis, given at 10:00.
      await plant("submission-verdicts", code.id, { reviews: [{ id: derivedId("sbm", "old"), verdict: "approve", by: "agent:rev", at: "2026-11-26T10:00:00.000Z" }] });
      const approved = async () => (await svc.approvalOf(code.id))?.approved;
      const because = async () => (await svc.approvalOf(code.id))?.outdated?.because;
      assert.equal(await approved(), true, "no contract and no decisions: it counts as before");
      const body = { taskId: task, projectId: project, changedBy: owner.id, acceptanceCriteria: ["a"], priority: 5, budget: {}, workClass: "P", requiredEvidence: [], checks: [], permissions: [], recovery: "native-continuation" };
      const version = (v: number, at: string, extra: object = {}) => plant("task-contract-version", `${task}.${v}`, { ...body, ...extra, version: v, changedAt: at });
      await version(1, "2026-11-26T09:00:00.000Z");
      await plant("task-contract", task, { ...body, version: 1 });
      assert.equal(await approved(), true, "the contract in force at its time is the current one");
      await version(2, "2026-11-26T11:00:00.000Z", { priority: 7 });
      await plant("task-contract", task, { ...body, priority: 7, version: 2 });
      assert.equal(await approved(), true, "a later priority change leaves it");
      await version(3, "2026-11-26T12:00:00.000Z", { priority: 7, acceptanceCriteria: ["b"] });
      await plant("task-contract", task, { ...body, priority: 7, acceptanceCriteria: ["b"], version: 3 });
      assert.equal(await because(), "the task contract's acceptanceCriteria changed since version 1 (now version 3, stored at 2026-11-26T12:00:00.000Z)");
      // A contract made only after the approval: judged against no contract (version 0, no criteria).
      await plant("task-contract-version", `${task}.1`, { ...body, version: 1, changedAt: "2026-11-26T10:30:00.000Z" });
      assert.equal(await because(), "the task contract's acceptanceCriteria changed since version 0 (now version 3, stored at 2026-11-26T12:00:00.000Z)");
      // A version that cannot be read on the way back, or more versions after the approval than the walk reads: it does not count (fail closed).
      await plant("task-contract-version", `${task}.2`, { broken: true });
      assert.equal(await because(), "the task contract's version 2 cannot be read, so the criteria this approval was judged against cannot be told");
      const last = APPROVAL_CONTRACT_WALK + 1;
      for (let v = 1; v <= last; v++) await version(v, `2026-11-26T${String(11 + Math.floor(v / 60)).padStart(2, "0")}:${String(v % 60).padStart(2, "0")}:00.000Z`, { acceptanceCriteria: ["a"] });
      await plant("task-contract", task, { ...body, version: last });
      assert.equal(await because(), `the task contract has changed more than ${APPROVAL_CONTRACT_WALK} times, so the criteria this approval was judged against cannot be told`);
      // Decisions: one linked before the approval and in force counts; one linked after it does not.
      await plant("task-contract", task, { ...body, version: 0 });
      const dA = derivedId("dec", cid("d"));
      await plant("decision", dA, { projectId: project, category: "decision", topic: "x", statement: "s", wording: "w", source: { channel: "direct" }, origin: { principalId: owner.id }, version: 1, state: "active", supersedes: [], recordedAt: "2026-11-26T08:00:00.000Z", contextVersion: 1 });
      const linked = (at: string) => plant("decision-reliance", relianceIdOf(task), { taskId: task, projectId: project, links: [{ id: "l1", subject: { kind: "task", id: task }, decisionId: dA, version: 1, topic: "x", state: "current", linkedBy: owner.id, linkedAt: at }], revalidations: 0, followUps: [] });
      await linked("2026-11-26T09:30:00.000Z");
      assert.equal(await approved(), true);
      await linked("2026-11-26T10:00:00.001Z");
      assert.equal(await because(), `the task has relied on owner decision ${dA} since 2026-11-26T10:00:00.001Z, which this approval was not judged against`);
    } finally { await world.close(); }
  });
}
