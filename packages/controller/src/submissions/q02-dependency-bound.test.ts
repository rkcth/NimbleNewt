// Card Q02 (finish): "changed dependency invalidates affected test/review" and "invalidation schedules revalidation" over the task's recorded dependencies (card C03), on all four storage backends.
// - QA evidence keeps the task's dependency manifest it was judged against (a shared snapshot); a dependency recorded again with another observation, or one the controller judges changed from its own state
//   (a shared record edited), makes it stale at once (the gate) and its re-check is scheduled for the recorder (the `recorded` hook and `dependenciesChanged`), once.
// - An approval, and code accepted without a review in a one-agent project, stop counting by the same rule (and by the superseded-decision and criteria rules for the one-agent case), fail closed.
// - The review scheduler asks a reviewer to review again once per approval that stopped counting, in a project with no review policy, and settles it when a newer review is recorded.
// - Verdicts must cite by default; the owner may make citing optional for a project; an old `false` that was only the default reads as required.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { after, test } from "node:test";
import { DomainError } from "../domain/errors.js";
import { derivedId } from "../domain/ids.js";
import { relianceIdOf } from "../decisions/records.js";
import { CommandRunner } from "../domain/runner.js";
import { ProjectService } from "../domain/service.js";
import { backends, stopServer } from "../domain/testing/backends.js";
import { DependencyService } from "../dependencies/index.js";
import { PrincipalService, type Principal } from "../security/index.js";
import type { JsonObject } from "../storage/types.js";
import { QaEvidenceService, QaReviewService, SubmissionService } from "./index.js";

after(stopServer);

let clock = "2026-11-26T10:00:00.000Z";
const options = { clock: () => clock, pause: async () => undefined };
let n = 0;
const cid = (label: string): string => `${label}-${n++}`;
const sha = (v: string): string => createHash("sha256").update(v).digest("hex");
const H1 = sha("one"), H2 = sha("two");
const T1 = "a".repeat(40), T2 = "e".repeat(40), BASE = "c".repeat(40), PATCH = "d".repeat(40), PATCH2 = "b".repeat(40);
const isDomain = (code: string, re: RegExp) => (e: unknown): boolean => e instanceof DomainError && e.code === code && re.test(e.message);

async function world(backend: (typeof backends)[number]) {
  const w = await backend.open();
  const projects = await ProjectService.open(w.storage, { holder: "c1", ...options });
  const principals = PrincipalService.withEpoch(w.storage, projects.epoch, options);
  const owner = await principals.authenticate((await principals.bootstrapOwner({ name: "rob" })).token);
  const project = (await projects.createProject({ commandId: cid("p"), actor: owner.id, name: "P" })).id;
  const task = (await projects.createTask({ commandId: cid("t"), actor: owner.id, projectId: project, title: "T" })).id;
  const runner = new CommandRunner(w.storage, projects.epoch, options);
  const plant = async (kind: string, id: string, body: object): Promise<void> => {
    const found = await runner.get(kind, id);
    await runner.command("test.plant", { commandId: cid("plant"), actor: owner.id }, async () => ({ payload: { kind, id }, build: async () => ({ ref: { kind, id }, creates: found === undefined, changes: [found === undefined ? { type: "create" as const, ref: { kind, id }, body: body as JsonObject } : { type: "update" as const, ref: { kind, id }, expectedRevision: found.revision, body: body as JsonObject }], detail: {} }) }));
  };
  const raw = async (kind: string, id: string): Promise<any> => (await w.storage.getAggregate({ kind, id }))?.body;
  const roles = new Map<string, string[]>();
  const agent = async (nm: string, held: string[]): Promise<Principal> => {
    await principals.enroll(owner, { commandId: cid("e"), kind: "agent", name: nm, grants: [{ action: "task.read", project }] });
    const p = await principals.authenticate((await principals.issueCredential(owner, `agent:${nm}`)).token);
    roles.set(p.id, held);
    return p;
  };
  const contractBody = { taskId: task, projectId: project, changedBy: owner.id, acceptanceCriteria: ["works"], priority: 5, budget: {}, workClass: "P", requiredEvidence: [], checks: [{ name: "unit", run: ["true"] }], permissions: [], recovery: "native-continuation" };
  const contract = async (version: number, extra: object = {}, changedAt = "2026-11-26T09:00:00.000Z"): Promise<void> => {
    await plant("task-contract", task, { ...contractBody, ...extra, version });
    await plant("task-contract-version", `${task}.${version}`, { ...contractBody, ...extra, version, changedAt });
  };
  const desk = derivedId("dsk", cid("desk"));
  const deskBody = (text: string) => ({ owner: owner.id, projectId: project, kind: "note", title: "spec", body: text, status: "accepted", visibility: "shared" });
  await plant("desk-record", desk, deskBody("spec v1"));
  return { w, projects, principals, owner, project, task, runner, plant, raw, roles, agent, contract, desk, deskBody };
}

for (const backend of backends) {
  test(`${backend.name}: QA evidence is bound to the task's recorded dependencies; a dependency recorded again or changed in the controller's own state invalidates it and schedules its re-check once (card Q02)`, async () => {
    const x = await world(backend);
    try {
      const { owner, task, project, plant, raw, desk, deskBody } = x;
      await x.contract(1);
      const qaAgent = await x.agent("qa", ["qa"]);
      const notices: string[] = [];
      const qa = QaEvidenceService.withEpoch(x.w.storage, x.projects.epoch, { rolesOf: async (id) => x.roles.get(id) ?? [], notify: async (m) => { if (!notices.includes(m.recheckId)) notices.push(m.recheckId); } }, options);
      const hooked: string[] = [];
      const deps = DependencyService.withEpoch(x.w.storage, x.projects.epoch, { ...options, recorded: async (t) => { hooked.push(t); await qa.dependenciesChanged(t); } });
      const sub = derivedId("sbm", cid("sub"));
      await plant("submission", sub, { taskId: task, projectId: project, kind: "code", role: "author", submittedBy: "agent:ann", submittedAt: "2026-11-26T09:00:00.000Z", makesCommit: true, base: BASE, tree: "e".repeat(64), patchId: PATCH, evidence: [] });
      const evidence = (label = "r") => qa.record(qaAgent, { commandId: cid(label), submissionId: sub, criteriaRevision: 1, environment: "linux", observedAt: "2026-11-26T09:30:00.000Z", checks: [{ name: "unit", result: "passed" }] });

      // A task with no manifest: evidence keeps `none`, and nothing about dependencies takes it back.
      const e0 = await evidence();
      assert.equal((await raw("qa-evidence", e0.id)).dependencySnapshot, "none");
      assert.equal((await qa.gate(owner, sub)).verdict, "passed");
      assert.deepEqual((await qa.dependenciesChanged(task)).invalidated, [], "no manifest: not read further");

      // The agent records a file and a shared record (owner here: the right to work the task). Evidence made before the manifest existed is not taken back by entries recorded after it (later work).
      await deps.record(owner, { commandId: cid("d"), taskId: task, dependencies: [{ kind: "file", key: "src/a.ts", hash: H1 }, { kind: "record", key: desk, hash: sha("spec v1") }] });
      assert.deepEqual(hooked, [task], "the recording tells the QA service");
      assert.equal((await qa.gate(owner, sub)).verdict, "passed", "dependencies recorded after the evidence are later work");

      const e1 = await evidence();
      const snap = (await raw("qa-evidence", e1.id)).dependencySnapshot as string;
      assert.match(snap, /^dps-[a-z2-7]{20}$/);
      const kept = await raw("dependency-snapshot", snap);
      assert.equal(Object.keys(kept.entries).length, 2);
      // A second record against the same manifest shares the snapshot.
      const e1b = await evidence();
      assert.equal((await raw("qa-evidence", e1b.id)).dependencySnapshot, snap);

      // 1. The file is recorded again with what is the same observation: nothing changes.
      await deps.record(owner, { commandId: cid("d"), taskId: task, dependencies: [{ kind: "file", key: "src/a.ts", hash: H1 }] });
      assert.equal((await qa.gate(owner, sub)).verdict, "passed", "the same observation again is no change");
      // 2. The file is recorded again with a different hash: the hook invalidates both records judged on it (not e0, which had no manifest), schedules their re-checks for the recorder, tells the owner once.
      clock = "2026-11-26T10:05:00.000Z";
      await deps.record(owner, { commandId: cid("d"), taskId: task, dependencies: [{ kind: "file", key: "src/a.ts", hash: H2 }] });
      const listed = await qa.list(owner, task);
      const byId = new Map(listed.items.map((i) => [i.id, i] as const));
      assert.deepEqual([byId.get(e0.id)!.state, byId.get(e1.id)!.state, byId.get(e1b.id)!.state], ["current", "invalidated", "invalidated"]);
      const reason = byId.get(e1.id)!.reasons![0]!;
      assert.equal(reason.kind, "dependency_changed");
      assert.deepEqual(listed.rechecks.map((r) => [r.evidenceId, r.assignee, r.requestedBy]).sort(), [[e1.id, qaAgent.id, "service:qa-evidence"], [e1b.id, qaAgent.id, "service:qa-evidence"]].sort());
      assert.equal(notices.length, 2);
      const gate = await qa.gate(owner, sub);
      assert.equal(gate.verdict, "passed", "e0 (no manifest then) still holds, so the gate still passes on it");
      // A repeat writes nothing more.
      assert.deepEqual((await qa.dependenciesChanged(task)).invalidated, []);
      assert.equal(notices.length, 2);
      // The plain words the owner reads.
      const { reasonText } = await import("./qa-evidence.js");
      assert.equal(reasonText(reason), `the task's recorded file dependency "src/a.ts" was recorded again with a different observation at 2026-11-26T10:05:00.000Z`);

      // 3. The shared record the task relied on is edited (no record of the task changes): the gate sees it at once; the scheduler's look (`dependenciesChanged`) invalidates it once.
      const e2 = await evidence();
      await plant("desk-record", desk, deskBody("spec v2"));
      const stale = await qa.gate(owner, sub);
      assert.ok(stale.stale.some((s) => s.id === e2.id && s.reasons.some((r) => r.kind === "dependency_changed" && r.change.status === "changed")), JSON.stringify(stale.stale));
      assert.equal(reasonText(stale.stale.find((s) => s.id === e2.id)!.reasons[0]!), `the task's recorded record dependency (entry ${derivedId("dpm", `record||${desk}`)}) changed (the record's content differs)`);
      const looked = await qa.dependenciesChanged(task);
      assert.deepEqual(looked.invalidated, [e2.id]);
      assert.deepEqual((await qa.dependenciesChanged(task)).invalidated, [], "once");
      // New evidence is refused while the recorded dependency is seen changed, with what to do; once the agent records it again, evidence is accepted.
      await assert.rejects(() => evidence(), isDomain("stale_revision", new RegExp(`record dependency \\(entry ${derivedId("dpm", `record||${desk}`)}\\) changed \\(the record's content differs\\): the work is looked at again against it \\(the task's agent records it again\\) before it is checked`)));
      await deps.record(owner, { commandId: cid("d"), taskId: task, dependencies: [{ kind: "record", key: desk, hash: sha("spec v2") }] });
      const e3 = await evidence();
      assert.equal((await raw("qa-evidence", e3.id)).state, "current");
      // The pending re-check of e2 is settled by e3 (it names the same check again).
      assert.ok((await qa.list(owner, task)).rechecks.some((r) => r.evidenceId === e2.id && r.state === "done" && r.doneBy === e3.id));

      // 4. Fail closed: a snapshot that cannot be read takes the evidence back.
      const snap3 = (await raw("qa-evidence", e3.id)).dependencySnapshot as string;
      const good = await raw("dependency-snapshot", snap3);
      await plant("dependency-snapshot", snap3, { ...good, taskId: "task-" + "z".repeat(20) });
      assert.ok((await qa.gate(owner, sub)).stale.some((s) => s.id === e3.id && reasonText(s.reasons[0]!) === "the task's recorded dependencies this was judged against cannot be read"));
      await plant("dependency-snapshot", snap3, good);

      // 5. Evidence recorded before dependencies were kept is judged by its time: an entry observed before it that the controller judges changed takes it back; one observed after it does not.
      const legacy = derivedId("qae", cid("legacy"));
      const base = { ...(await raw("qa-evidence", e3.id)), state: "current" } as Record<string, unknown>;
      delete base["dependencySnapshot"];
      await plant("qa-evidence", legacy, { ...base, recordedAt: "2026-11-26T11:00:00.000Z" });
      const index = await raw("qa-evidence-index", task);
      await plant("qa-evidence-index", task, { ...index, ids: [...index.ids, legacy] });
      assert.ok(!(await qa.gate(owner, sub)).stale.some((s) => s.id === legacy), "nothing changed: holds");
      await plant("desk-record", desk, deskBody("spec v3"));
      assert.ok((await qa.gate(owner, sub)).stale.some((s) => s.id === legacy && s.reasons.some((r) => r.kind === "dependency_changed")), "observed before it, changed now: stale");
      await plant("qa-evidence", legacy, { ...base, recordedAt: "2026-11-26T08:00:00.000Z" });
      assert.ok(!(await qa.gate(owner, sub)).stale.some((s) => s.id === legacy), "the entry was observed after it (perhaps a later recording): not judged");
    } finally { await x.w.close(); }
  });

  test(`${backend.name}: an approval, and code accepted without a review in a one-agent project, stop counting when a recorded dependency, a relied-on decision or the criteria change after them; new work or a new review restores them (card Q02)`, async () => {
    const x = await world(backend);
    try {
      const { owner, task, project, plant, raw, desk, deskBody } = x;
      await x.contract(1);
      const deps = DependencyService.withEpoch(x.w.storage, x.projects.epoch, options);
      await deps.record(owner, { commandId: cid("d"), taskId: task, dependencies: [{ kind: "file", key: "src/a.ts", hash: H1 }, { kind: "record", key: desk, hash: sha("spec v1") }] });
      const ann = await x.agent("ann", ["author"]);
      const rev = await x.agent("rev", ["reviewer"]);
      const svc = SubmissionService.withEpoch(x.w.storage, x.projects.epoch, async (id) => x.roles.get(id) ?? [], options);
      const code = await svc.record(ann, { commandId: cid("s"), taskId: task, kind: "code", role: "author", base: BASE, tree: T1, patchId: PATCH });
      const review = (verdict: string) => svc.record(rev, { commandId: cid("rv"), taskId: task, kind: "review", role: "reviewer", subject: code.id, verdict } as never);

      const a1 = await review("approve");
      const basis = (await raw("submission", a1.id)).judgedAgainst;
      assert.match(basis.dependencies, /^dps-/);
      assert.equal((await svc.approvalOf(code.id))?.approved, true);
      // The file is recorded again with another observation: the approval stops counting, in plain words.
      clock = "2026-11-26T10:10:00.000Z";
      await deps.record(owner, { commandId: cid("d"), taskId: task, dependencies: [{ kind: "file", key: "src/a.ts", hash: H2 }] });
      const out = await svc.approvalOf(code.id);
      assert.deepEqual([out?.approved, out?.outdated?.reviewId], [false, a1.id]);
      assert.equal(out?.outdated?.because, `the task's recorded file dependency "src/a.ts" was recorded again with a different observation at 2026-11-26T10:10:00.000Z`);
      assert.match(out!.reason!, /no longer counts: the task's recorded file dependency .*; a reviewer has to review it again/);
      // A new review restores it.
      await review("approve");
      assert.equal((await svc.approvalOf(code.id))?.approved, true);
      // The shared record is edited: the approval stops counting; a new approval is refused while it is seen changed (a request for changes is recorded); once recorded again, an approval stands.
      await plant("desk-record", desk, deskBody("spec v2"));
      assert.match((await svc.approvalOf(code.id))!.outdated!.because, new RegExp(`record dependency \\(entry ${derivedId("dpm", `record||${desk}`)}\\) changed \\(the record's content differs\\)`));
      await assert.rejects(() => review("approve"), isDomain("invalid_command", /an approval waits until the task's agent has looked at the work against it again \(and records it again\); a request for changes or a rejection can be recorded now/));
      await review("changes");
      await deps.record(owner, { commandId: cid("d"), taskId: task, dependencies: [{ kind: "record", key: desk, hash: sha("spec v2") }] });
      await review("approve");
      assert.equal((await svc.approvalOf(code.id))?.approved, true);
      // An approval recorded before dependencies were kept (its basis has none) is judged by its time.
      const verdicts = await raw("submission-verdicts", code.id);
      const last = verdicts.reviews[verdicts.reviews.length - 1];
      await plant("submission-verdicts", code.id, { reviews: [...verdicts.reviews.slice(0, -1), { ...last, at: "2026-11-26T12:00:00.000Z", basis: { criteriaRevision: last.basis.criteriaRevision, decisions: last.basis.decisions } }] });
      assert.equal((await svc.approvalOf(code.id))?.approved, true);
      await plant("desk-record", desk, deskBody("spec v3"));
      assert.equal((await svc.approvalOf(code.id))?.approved, false, "an entry observed before it, changed now");

      // A one-agent project: the code is accepted without a review and keeps what it was accepted against.
      const solo = (await x.projects.createTask({ commandId: cid("t"), actor: owner.id, projectId: project, title: "Solo" })).id;
      const single = SubmissionService.withEpoch(x.w.storage, x.projects.epoch, async (id) => x.roles.get(id) ?? [], { ...options, reviewersAvailableIn: async () => [] });
      const dec = derivedId("dec", cid("d")), dec2 = derivedId("dec", cid("d"));
      const decision = (state: string, extra: object = {}) => ({ projectId: project, category: "decision", topic: "format", statement: "s", wording: "w", source: { channel: "direct" }, origin: { principalId: owner.id }, version: 1, state, supersedes: [], recordedAt: "2026-11-26T09:00:00.000Z", contextVersion: 1, ...extra });
      await plant("decision", dec, decision("active"));
      const link = (id: string, linkedAt: string) => ({ id: `l-${id}`, subject: { kind: "task", id: solo }, decisionId: id, version: 1, topic: "format", state: "current", linkedBy: owner.id, linkedAt });
      await plant("decision-reliance", relianceIdOf(solo), { taskId: solo, projectId: project, links: [link(dec, "2026-11-26T09:01:00.000Z")], revalidations: 0, followUps: [] });
      await deps.record(owner, { commandId: cid("d"), taskId: solo, dependencies: [{ kind: "file", key: "src/b.ts", hash: H1 }] });
      const soloCode = async (tree: string, patch: string) => single.record(ann, { commandId: cid("s"), taskId: solo, kind: "code", role: "author", base: BASE, tree, patchId: patch });
      const c1 = await soloCode(T1, PATCH);
      const kept = (await raw("submission", c1.id)).judgedAgainst;
      assert.deepEqual([kept.criteriaRevision, kept.decisions, typeof kept.dependencies], [0, [`${dec}@1`], "string"]);
      assert.deepEqual([(await single.approvalOf(c1.id))?.approved, (await single.approvalOf(c1.id))?.approvedBy], [true, "review_disabled_single_agent"]);
      // The owner corrects the decision: the code no longer lands on its unreviewed acceptance (the superseded-decision check now applies to it too).
      await plant("decision", dec, decision("superseded", { supersededBy: dec2, supersededAt: "2026-11-26T11:00:00.000Z" }));
      const soloOut = await single.approvalOf(c1.id);
      assert.deepEqual([soloOut?.approved, soloOut?.outdated?.approvedBy, soloOut?.outdated?.reviewId], [false, "review_disabled_single_agent", c1.id]);
      assert.equal(soloOut?.outdated?.because, `owner decision ${dec} was superseded by ${dec2} at 2026-11-26T11:00:00.000Z`);
      assert.match(soloOut!.reason!, /^it was accepted without a review at .* \(no other agent of the project could review it\), but that no longer counts: owner decision .* was superseded .*; it has to be submitted again \(or reviewed by an agent added to the project\) against the current decisions and criteria$/);
      // Work revalidated onto the correcting decision and submitted again is accepted again.
      await plant("decision", dec2, decision("active"));
      await plant("decision-reliance", relianceIdOf(solo), { taskId: solo, projectId: project, links: [link(dec2, "2026-11-26T11:05:00.000Z")], revalidations: 1, followUps: [] });
      assert.equal((await single.approvalOf(c1.id))?.approved, false, "still judged on the old decision");
      const c2 = await soloCode(T2, PATCH2);
      assert.equal((await single.approvalOf(c2.id))?.approved, true);
      // A criteria change and a recorded dependency change take it back as well.
      await plant("task-contract", solo, { ...{ taskId: solo, projectId: project, changedBy: owner.id, acceptanceCriteria: ["other"], priority: 5, budget: {}, workClass: "P", requiredEvidence: [], checks: [], permissions: [], recovery: "native-continuation" }, version: 1 });
      await plant("task-contract-version", `${solo}.1`, { taskId: solo, projectId: project, changedBy: owner.id, acceptanceCriteria: ["other"], version: 1, changedAt: "2026-11-26T12:00:00.000Z" });
      assert.match((await single.approvalOf(c2.id))!.outdated!.because, /^the task contract's acceptanceCriteria changed since version 0/);
      const c3 = await soloCode("9".repeat(40), "8".repeat(40));
      assert.equal((await single.approvalOf(c3.id))?.approved, true);
      await deps.record(owner, { commandId: cid("d"), taskId: solo, dependencies: [{ kind: "file", key: "src/b.ts", hash: H2 }] });
      assert.match((await single.approvalOf(c3.id))!.outdated!.because, /file dependency "src\/b\.ts" was recorded again/);
      // Code accepted this way before the basis was kept is judged by its time: a link made after it takes it back.
      const old = derivedId("sbm", cid("old"));
      const oldBody = { ...(await raw("submission", c3.id)), submittedAt: "2026-11-26T10:30:00.000Z" } as Record<string, unknown>;
      delete oldBody["judgedAgainst"];
      await plant("submission", old, oldBody);
      assert.match((await single.approvalOf(old))!.outdated!.because, new RegExp(`relied on owner decision ${dec2} since 2026-11-26T11:05:00.000Z, which this approval was not judged against`));
    } finally { await x.w.close(); clock = "2026-11-26T10:00:00.000Z"; }
  });

  test(`${backend.name}: the scheduler asks the reviewer to review again once per approval that stopped counting, in a project without a review policy, and settles it when a newer review is recorded (card Q02)`, async () => {
    const x = await world(backend);
    try {
      const { owner, task, project, plant } = x;
      await x.contract(1);
      const ann = await x.agent("ann", ["author"]);
      const rev = await x.agent("rev", ["reviewer"]);
      const rev2 = await x.agent("rev2", ["reviewer"]);
      const svc = SubmissionService.withEpoch(x.w.storage, x.projects.epoch, async (id) => x.roles.get(id) ?? [], options);
      const qa = QaEvidenceService.withEpoch(x.w.storage, x.projects.epoch, { rolesOf: async (id) => x.roles.get(id) ?? [] }, options);
      const told: { to: string; text: string; id: string }[] = [];
      const looked: string[] = [];
      let pool = [rev.id, rev2.id];
      const ports = { reviewers: async () => pool, notice: async (m: { commandId: string; to: string; text: string }) => { if (!told.some((t) => t.id === m.commandId)) told.push({ to: m.to, text: m.text, id: m.commandId }); }, approvalOf: (id: string) => svc.approvalOf(id), dependenciesChanged: async (t: string) => { looked.push(t); } };
      const sched = QaReviewService.withEpoch(x.w.storage, x.projects.epoch, qa, ports, options);
      const code = await svc.record(ann, { commandId: cid("s"), taskId: task, kind: "code", role: "author", base: BASE, tree: T1, patchId: PATCH });
      // rev2 is the least loaded but rev approved it: rev is asked again (it knows the work).
      await (sched as unknown as { sweep(): Promise<unknown> }).sweep();
      assert.equal((await sched.requests(owner, project)).total, 0, "nothing stale: nothing asked");
      assert.deepEqual(looked, [task], "the task's QA evidence is looked at against its dependencies each round");
      const a1 = await svc.record(rev, { commandId: cid("rv"), taskId: task, kind: "review", role: "reviewer", subject: code.id, verdict: "approve" });
      await x.contract(2, { acceptanceCriteria: ["works", "fast"] }, "2026-11-26T11:00:00.000Z");
      const r1 = await sched.sweep();
      assert.equal(r1.created, 1);
      const open = (await sched.requests(owner, project)).items;
      assert.deepEqual(open.map((r) => [r.trigger, r.approval, r.cause.startsWith(`${a1.id}@`), r.assignee, r.approvedBy]), [["reapproval", a1.id, true, rev.id, rev.id]]);
      assert.match(open[0]!.reason!, /^the task contract's acceptanceCriteria changed since version 1/);
      assert.equal(told.length, 1);
      assert.equal(told[0]!.to, rev.id);
      assert.match(told[0]!.text, new RegExp(`^Please review task ${task}'s code ${code.id} again: its approval by ${rev.id} no longer counts \\(the task contract's acceptanceCriteria changed`));
      // Repeated rounds, and a second controller, make it once and tell once.
      await sched.sweep();
      const other = QaReviewService.withEpoch(x.w.storage, x.projects.epoch, qa, ports, options);
      assert.equal((await other.sweep()).created, 0);
      assert.deepEqual([(await sched.requests(owner, project)).total, told.length], [1, 1]);
      // The assigned reviewer sees it in its own list.
      assert.equal((await sched.requests(rev, project)).total, 1);
      // A newer review (here a request for changes by rev2) settles it.
      await svc.record(rev2, { commandId: cid("rv"), taskId: task, kind: "review", role: "reviewer", subject: code.id, verdict: "changes", criteriaRevision: 2 });
      const r2 = await sched.sweep();
      assert.deepEqual([r2.settled, (await sched.requests(owner, project)).total], [1, 0]);
      // Approved again, then stale again: a new request for the new approval (its own cause).
      const a3 = await svc.record(rev2, { commandId: cid("rv"), taskId: task, kind: "review", role: "reviewer", subject: code.id, verdict: "approve", criteriaRevision: 2 });
      await x.contract(3, { acceptanceCriteria: ["works", "fast", "small"] }, "2026-11-26T12:00:00.000Z");
      await sched.sweep();
      const third = (await sched.requests(owner, project)).items;
      assert.deepEqual(third.map((r) => [r.approval, r.assignee]), [[a3.id, rev2.id]]);
      // The approval counts again (the criteria put back): the request is settled as restored.
      await x.contract(4, { acceptanceCriteria: ["works", "fast"] }, "2026-11-26T12:30:00.000Z");
      assert.equal((await svc.approvalOf(code.id))?.approved, true);
      assert.equal((await sched.sweep()).settled, 1);
      const settled = await x.raw("qa-review-request", third[0]!.id);
      assert.deepEqual([settled.state, settled.settledBy], ["done", a3.id]);
      // The same approval stops counting again (another change): asked again, once. Nobody else can review it now (every reviewer worked on it or left): the owner is told, once.
      await x.contract(5, { acceptanceCriteria: ["other"] }, "2026-11-26T13:00:00.000Z");
      pool = [];
      await sched.sweep();
      await sched.sweep();
      const ownerNotes = told.filter((t) => t.to === "owner");
      assert.equal(ownerNotes.length, 1);
      assert.deepEqual((await sched.requests(owner, project)).items.map((r) => [r.approval, r.assignee]), [[a3.id, undefined]]);
      assert.match(ownerNotes[0]!.text, /needs a review again: its approval no longer counts .*No reviewer agent of the project that did not work on the task can do it/);
      void plant;
    } finally { await x.w.close(); }
  });

  test(`${backend.name}: by default a rejection must name the unmet requirement and every verdict records the criteria version it was judged against; the owner may make it optional, or ask every verdict to cite; an old false that was only the default is the default; old uncited rejections stay as history (card Q02)`, async () => {
    const x = await world(backend);
    try {
      const { owner, task, project, plant, raw } = x;
      await x.contract(1);
      const ann = await x.agent("ann", ["author"]);
      const rev = await x.agent("rev", ["reviewer"]);
      const qa = QaEvidenceService.withEpoch(x.w.storage, x.projects.epoch, { rolesOf: async () => [] }, options);
      const policy = QaReviewService.withEpoch(x.w.storage, x.projects.epoch, qa, { reviewers: async () => [] }, options);
      const before = SubmissionService.withEpoch(x.w.storage, x.projects.epoch, async (id) => x.roles.get(id) ?? [], options);
      const svc = SubmissionService.withEpoch(x.w.storage, x.projects.epoch, async (id) => x.roles.get(id) ?? [], { ...options, citationRule: (p, t) => policy.citationRule(p, t) });
      const code = await svc.record(ann, { commandId: cid("s"), taskId: task, kind: "code", role: "author", base: BASE, tree: T1, patchId: PATCH });
      const rv = (s: SubmissionService, verdict: string, extra: object = {}) => s.record(rev, { commandId: cid("rv"), taskId: task, kind: "review", role: "reviewer", subject: code.id, verdict, ...extra } as never);
      // A rejection that named nothing, recorded before the default (a service with no rule), stays valid history: it is the newest verdict and is read as before.
      await rv(before, "reject");
      assert.deepEqual([(await svc.approvalOf(code.id))?.newest, (await svc.approvalOf(code.id))?.cited], ["reject", undefined]);

      // No policy: the default. A rejection that names nothing is refused, saying plainly what to add.
      assert.equal(await policy.citationRule(project, task), "rejections");
      await assert.rejects(() => rv(svc, "reject"), isDomain("invalid_command", /^unmet: a rejection names the owner requirement that is not met: add unmet \(the acceptance criterion or owner decision, in your words\); the task contract version in force is recorded with it unless you name one in criteriaRevision\. The owner can make this optional for a project$/));
      // Naming the unmet requirement is enough: the version in force (1) is cited for it, and the view shows both.
      const rj = await rv(svc, "reject", { unmet: "it must work offline" });
      assert.deepEqual([(await raw("submission", rj.id)).criteriaRevision, (await svc.approvalOf(code.id))?.cited], [1, { criteriaRevision: 1, decisions: [], unmet: "it must work offline" }]);
      // A request for changes and an approval that cite nothing are recorded, each with the criteria version it was judged against.
      const ch = await rv(svc, "changes");
      assert.deepEqual((await raw("submission", ch.id)).judgedAgainst, { criteriaRevision: 1, decisions: [] });
      const ap = await rv(svc, "approve");
      assert.equal((await raw("submission", ap.id)).judgedAgainst.criteriaRevision, 1);
      // Only a rejection names what is unmet.
      await assert.rejects(() => rv(svc, "changes", { unmet: "x" }), isDomain("invalid_command", /^unmet: only a rejection names the owner requirement it found unmet$/));
      // A repeat of the rejection after the contract moved answers the first record (the version was read after the repeat check).
      const cmd = cid("rv");
      const first = await svc.record(rev, { commandId: cmd, taskId: task, kind: "review", role: "reviewer", subject: code.id, verdict: "reject", unmet: "still offline" } as never);
      await x.contract(2, { acceptanceCriteria: ["works", "offline"] });
      const again = await svc.record(rev, { commandId: cmd, taskId: task, kind: "review", role: "reviewer", subject: code.id, verdict: "reject", unmet: "still offline" } as never);
      assert.deepEqual([again.id, again.replayed, (await raw("submission", first.id)).criteriaRevision], [first.id, true, 1]);
      const view = await policy.get(owner, project);
      assert.deepEqual([view.isDefault, view.item.citations], [true, "rejections"]);

      // A policy record written before the default changed holds a `false` nobody chose: it is the default (shown so), also after another field is set.
      await plant("qa-review-policy", project, { projectId: project, scope: { workClasses: [], taskIds: [] }, triggers: { onSubmission: false, periodicMinutes: null, onIncident: false }, requiredChecks: [], gatesCompletion: false, independentSources: 1, requireVerdictCitations: false, since: {}, updatedBy: owner.id, updatedAt: "2026-11-24T10:00:00.000Z" });
      assert.deepEqual([await policy.citationRule(project, task), (await policy.get(owner, project)).item.citations], ["rejections", "rejections"]);
      await policy.set(owner, { commandId: cid("ps"), projectId: project, independentSources: 2 });
      assert.equal(await policy.citationRule(project, task), "rejections");
      await assert.rejects(() => rv(svc, "reject"), isDomain("invalid_command", /^unmet: a rejection names/));
      // The owner's own choice makes it optional (kept when another field changes); and asks every verdict to cite; and back.
      await policy.set(owner, { commandId: cid("ps"), projectId: project, requireVerdictCitations: false });
      assert.deepEqual([await policy.citationRule(project, task), (await policy.get(owner, project)).item.citations], ["optional", "optional"]);
      await rv(svc, "reject");
      await policy.set(owner, { commandId: cid("ps"), projectId: project, onSubmission: true });
      assert.equal(await policy.citationRule(project, task), "optional");
      await policy.set(owner, { commandId: cid("ps"), projectId: project, requireVerdictCitations: true });
      assert.equal(await policy.citationRule(project, task), "explicit");
      await assert.rejects(() => rv(svc, "approve"), isDomain("invalid_command", /^criteriaRevision: this project's review policy requires a verdict to cite what it was judged against/));
      await assert.rejects(() => rv(svc, "reject", { unmet: "x" }), isDomain("invalid_command", /^criteriaRevision: this project's review policy requires a verdict to cite/));
      await rv(svc, "changes", { criteriaRevision: 2 });
      // A policy that cannot be read refuses rather than records under a looser rule.
      const failing = SubmissionService.withEpoch(x.w.storage, x.projects.epoch, async (id) => x.roles.get(id) ?? [], { ...options, citationRule: async () => { throw new DomainError("unavailable", "storage unavailable"); } });
      await assert.rejects(() => rv(failing, "changes"), isDomain("unavailable", /storage unavailable/));
    } finally { await x.w.close(); }
  });
}
