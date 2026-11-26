// Card Q02 (finish, first review): cases the first implementation did not cover, on all four storage backends.
// - A shared record the task relied on that was superseded (or deleted, or a tool version revoked) cannot be "recorded again" into an unchanged state: recording it again after the change is the agent's
//   acknowledgement, so new evidence and approvals are accepted again (and evidence or approvals judged before the acknowledgement stay taken back).
// - The same search recorded again at a later position of the event stream, with the same results, is no change.
// - An approval that stops counting, counts again and stops counting again for the same reason is asked to be reviewed again (one request per episode), still once per episode with a second controller.
// - An approval made before dependencies were kept is judged against an entry observed at the very same millisecond (fail closed, as the decision links are).
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { after, test } from "node:test";
import { DomainError } from "../domain/errors.js";
import { derivedId } from "../domain/ids.js";
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
const H1 = sha("one");
const T1 = "a".repeat(40), BASE = "c".repeat(40), PATCH = "d".repeat(40);
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
  await plant("task-contract", task, { ...contractBody, version: 1 });
  await plant("task-contract-version", `${task}.1`, { ...contractBody, version: 1, changedAt: "2026-11-26T09:00:00.000Z" });
  const desk = derivedId("dsk", cid("desk"));
  const deskBody = (text: string, status = "accepted") => ({ owner: owner.id, projectId: project, kind: "note", title: "spec", body: text, status, visibility: "shared" });
  await plant("desk-record", desk, deskBody("spec v1"));
  const ann = await agent("ann", ["author"]);
  const rev = await agent("rev", ["reviewer"]);
  const qaAgent = await agent("qa", ["qa"]);
  const svc = SubmissionService.withEpoch(w.storage, projects.epoch, async (id) => roles.get(id) ?? [], options);
  const qa = QaEvidenceService.withEpoch(w.storage, projects.epoch, { rolesOf: async (id) => roles.get(id) ?? [] }, options);
  const deps = DependencyService.withEpoch(w.storage, projects.epoch, { ...options, recorded: async (t) => { await qa.dependenciesChanged(t); } });
  const code = await svc.record(ann, { commandId: cid("s"), taskId: task, kind: "code", role: "author", base: BASE, tree: T1, patchId: PATCH });
  const review = (verdict: string, by: Principal = rev) => svc.record(by, { commandId: cid("rv"), taskId: task, kind: "review", role: "reviewer", subject: code.id, verdict, ...(verdict === "reject" ? { unmet: "it must work" } : {}) } as never);
  const evidence = () => qa.record(qaAgent, { commandId: cid("qe"), submissionId: code.id, criteriaRevision: 1, environment: "linux", observedAt: "2026-11-26T09:30:00.000Z", checks: [{ name: "unit", result: "passed" }] });
  return { w, projects, owner, project, task, runner, plant, raw, roles, agent, desk, deskBody, ann, rev, qaAgent, svc, qa, deps, code, review, evidence };
}

for (const backend of backends) {
  test(`${backend.name}: a relied-on record superseded, or a tool version revoked, is acknowledged by recording it again: new evidence and approvals are accepted again, older ones stay taken back (card Q02 review)`, async () => {
    const x = await world(backend);
    try {
      const { owner, task, plant, desk, deskBody, svc, code, qa, deps } = x;
      await deps.record(owner, { commandId: cid("d"), taskId: task, dependencies: [{ kind: "record", key: desk, hash: sha("spec v1") }] });
      const a1 = await x.review("approve");
      const e1 = await x.evidence();
      assert.equal((await svc.approvalOf(code.id))?.approved, true);
      // The record is superseded (its content is unchanged): the approval and the evidence are taken back, and new ones are refused, saying what to do.
      await plant("desk-record", desk, deskBody("spec v1", "superseded"));
      assert.deepEqual([(await svc.approvalOf(code.id))?.outdated?.reviewId, (await svc.approvalOf(code.id))?.outdated?.because], [a1.id, `the task's recorded record dependency (entry ${derivedId("dpm", `record||${desk}`)}) changed (the record was superseded)`]);
      await assert.rejects(() => x.review("approve"), isDomain("invalid_command", /the record was superseded\): an approval waits until the task's agent has looked at the work against it again \(and records it again\)/));
      await assert.rejects(() => x.evidence(), isDomain("stale_revision", /the record was superseded\): the work is looked at again against it \(the task's agent records it again\)/));
      // The acknowledgement is the controller's own field: a caller cannot set it.
      await assert.rejects(() => deps.record(owner, { commandId: cid("d"), taskId: task, dependencies: [{ kind: "record", key: desk, hash: sha("spec v1"), seen: "0".repeat(16) } as never] }), (e: unknown) => e instanceof DomainError && e.code === "invalid_command");
      // The agent looks again and records the dependency again as it is now: that is the acknowledgement. New evidence and a new approval are accepted and count; the older evidence stays invalidated.
      clock = "2026-11-26T10:20:00.000Z";
      await deps.record(owner, { commandId: cid("d"), taskId: task, dependencies: [{ kind: "record", key: desk, hash: sha("spec v1") }] });
      assert.equal((await x.raw("qa-evidence", e1.id)).state, "invalidated", "evidence judged before the acknowledgement stays taken back");
      const a2 = await x.review("approve");
      const e2 = await x.evidence();
      assert.deepEqual([(await svc.approvalOf(code.id))?.approved, (await svc.approvalOf(code.id))?.reviewId], [true, a2.id]);
      assert.equal((await qa.gate(owner, code.id)).verdict, "passed");
      assert.equal((await x.raw("qa-evidence", e2.id)).state, "current");
      // A further change of the same record (its content edited after the acknowledgement) is a new change: taken back again, and refused until it is recorded again.
      await plant("desk-record", desk, deskBody("spec v1-edited", "superseded"));
      assert.match((await svc.approvalOf(code.id))!.outdated!.because, /the record's content differs|the record was superseded/);
      await assert.rejects(() => x.review("approve"), isDomain("invalid_command", /an approval waits/));

      // A tool version revoked: recorded again, it is acknowledged the same way.
      const version = derivedId("cav", cid("v"));
      await plant("catalog-version", version, { name: "tool", version: "1.0.0", digest: H1 });
      await plant("catalog-entry", derivedId("cat", "tool"), { name: "tool", revoked: [] });
      await deps.record(owner, { commandId: cid("d"), taskId: task, dependencies: [{ kind: "record", key: desk, hash: sha("spec v1-edited") }, { kind: "tool-version", key: version, hash: H1 }] });
      await x.review("approve");
      await plant("catalog-entry", derivedId("cat", "tool"), { name: "tool", revoked: ["1.0.0"] });
      assert.match((await svc.approvalOf(code.id))!.outdated!.because, /tool-version dependency .* changed \(the version was revoked\)/);
      await assert.rejects(() => x.review("approve"), isDomain("invalid_command", /the version was revoked/));
      await deps.record(owner, { commandId: cid("d"), taskId: task, dependencies: [{ kind: "tool-version", key: version, hash: H1 }] });
      await x.review("approve");
      assert.equal((await svc.approvalOf(code.id))?.approved, true);
    } finally { await x.w.close(); clock = "2026-11-26T10:00:00.000Z"; }
  });

  test(`${backend.name}: the same search recorded again later with the same results, or an ETag recorded again weak, is no change; other results are (card Q02 review)`, async () => {
    const x = await world(backend);
    try {
      const { owner, task, svc, code, deps } = x;
      await deps.record(owner, { commandId: cid("d"), taskId: task, dependencies: [{ kind: "search", key: "q", scope: { query: "spec" }, cursor: 10, hash: H1 }, { kind: "external", key: "https://example.invalid/a", etag: "\"v1\"", freshness: "conditional-read" }] });
      await x.review("approve");
      clock = "2026-11-26T10:30:00.000Z";
      await deps.record(owner, { commandId: cid("d"), taskId: task, dependencies: [{ kind: "search", key: "q", scope: { query: "spec" }, cursor: 42, hash: H1 }, { kind: "external", key: "https://example.invalid/a", etag: "W/\"v1\"", freshness: "conditional-read" }] });
      assert.equal((await svc.approvalOf(code.id))?.approved, true, JSON.stringify(await svc.approvalOf(code.id)));
      await deps.record(owner, { commandId: cid("d"), taskId: task, dependencies: [{ kind: "search", key: "q", scope: { query: "spec" }, cursor: 43, hash: sha("other results") }] });
      assert.match((await svc.approvalOf(code.id))!.outdated!.because, /search dependency "q" was recorded again with a different observation/);
    } finally { await x.w.close(); clock = "2026-11-26T10:00:00.000Z"; }
  });

  test(`${backend.name}: an approval that stops counting, counts again and stops counting again for the same reason is asked again, once per episode, also with a second controller (card Q02 review)`, async () => {
    const x = await world(backend);
    try {
      const { owner, task, project, plant, desk, deskBody, svc, code, qa, deps } = x;
      const told: string[] = [];
      const ports = { reviewers: async () => [x.rev.id], notice: async (m: { commandId: string }) => { if (!told.includes(m.commandId)) told.push(m.commandId); }, approvalOf: (id: string) => svc.approvalOf(id), dependenciesChanged: (t: string) => qa.dependenciesChanged(t) };
      const sched = QaReviewService.withEpoch(x.w.storage, x.projects.epoch, qa, ports, options);
      const other = QaReviewService.withEpoch(x.w.storage, x.projects.epoch, qa, ports, options);
      await deps.record(owner, { commandId: cid("d"), taskId: task, dependencies: [{ kind: "record", key: desk, hash: sha("spec v1") }] });
      const a1 = await x.review("approve");
      const episodes: string[] = [];
      for (const round of [1, 2, 3]) {
        // Stale (the record edited), asked once even with two controllers; then restored (edited back), settled as restored.
        await plant("desk-record", desk, deskBody(`spec v1 edited ${round}`));
        await sched.sweep(); await other.sweep(); await sched.sweep();
        const open = (await sched.requests(owner, project)).items;
        assert.equal(open.length, 1, `round ${round}: one open request`);
        assert.equal(open[0]!.approval, a1.id);
        assert.ok(!episodes.includes(open[0]!.id), `round ${round}: a new request for a new episode`);
        episodes.push(open[0]!.id);
        await plant("desk-record", desk, deskBody("spec v1"));
        assert.equal((await svc.approvalOf(code.id))?.approved, true);
        await other.sweep();
        assert.deepEqual([(await sched.requests(owner, project)).total, (await x.raw("qa-review-request", open[0]!.id)).state], [0, "done"]);
      }
      assert.equal(told.length, 3, "one notice per episode");
    } finally { await x.w.close(); }
  });

  test(`${backend.name}: one round looks at a bounded number of tasks for stale approvals and changed dependencies, and the rounds go through all of them in turn (card Q02 review)`, async () => {
    const x = await world(backend);
    try {
      const { owner, project, svc, qa } = x;
      // Two more tasks, each with approved code; then every approval stops counting (the criteria of each change).
      const tasks = [x.task];
      for (const t of ["U", "V"]) tasks.push((await x.projects.createTask({ commandId: cid("t"), actor: owner.id, projectId: project, title: t })).id);
      for (const t of tasks.slice(1)) {
        const c = await svc.record(x.ann, { commandId: cid("s"), taskId: t, kind: "code", role: "author", base: BASE, tree: sha(t).slice(0, 40), patchId: PATCH });
        await svc.record(x.rev, { commandId: cid("rv"), taskId: t, kind: "review", role: "reviewer", subject: c.id, verdict: "approve" });
      }
      await x.review("approve");
      for (const t of tasks) await x.plant("task-contract", t, { taskId: t, projectId: project, changedBy: owner.id, acceptanceCriteria: ["other"], version: t === x.task ? 2 : 1 });      const looked: string[] = [];
      const sched = QaReviewService.withEpoch(x.w.storage, x.projects.epoch, qa, { reviewers: async () => [x.rev.id], approvalOf: (id: string) => svc.approvalOf(id), dependenciesChanged: async (t: string) => { looked.push(t); }, looksPerRound: 1 }, options);
      const created: number[] = [];
      for (let round = 0; round < 3; round++) created.push((await sched.sweep()).created);
      assert.deepEqual([created, looked.length, new Set(looked).size], [[1, 1, 1], 3, 3], "one task per round, each in turn");
      assert.equal((await sched.requests(owner, project)).total, 3);
    } finally { await x.w.close(); }
  });

  test(`${backend.name}: a shared record edited after a round looked at the task's evidence is still invalidated by the next look, with its re-check, once per state (card Q02 review)`, async () => {
    const x = await world(backend);
    try {
      const { owner, task, plant, desk, deskBody, qa, deps } = x;
      await deps.record(owner, { commandId: cid("d"), taskId: task, dependencies: [{ kind: "record", key: desk, hash: sha("spec v1") }] });
      const e1 = await x.evidence();
      assert.deepEqual((await qa.dependenciesChanged(task)).invalidated, [], "nothing changed yet");
      // Only the shared record changes: no record of the task does.
      await plant("desk-record", desk, deskBody("spec v2"));
      assert.deepEqual((await qa.dependenciesChanged(task)).invalidated, [e1.id], "the next look sees it");
      assert.ok((await qa.list(owner, task)).rechecks.some((r) => r.evidenceId === e1.id && r.assignee === x.qaAgent.id));
      assert.deepEqual((await qa.dependenciesChanged(task)).invalidated, [], "a repeat writes nothing");
      // Two records judged against different snapshots: a change that takes back only the newer one, then a second change (again no record of the task) that takes back the older one: each look sees its own.
      const other = derivedId("dsk", cid("desk"));
      await plant("desk-record", other, deskBody("other v1"));
      await deps.record(owner, { commandId: cid("d"), taskId: task, dependencies: [{ kind: "record", key: desk, hash: sha("spec v2") }] });
      const e2 = await x.evidence();
      await deps.record(owner, { commandId: cid("d"), taskId: task, dependencies: [{ kind: "record", key: other, hash: sha("other v1") }] });
      const e3 = await x.evidence();
      await plant("desk-record", other, deskBody("other v2"));
      assert.deepEqual((await qa.dependenciesChanged(task)).invalidated, [e3.id]);
      await plant("desk-record", desk, deskBody("spec v3"));
      assert.deepEqual((await qa.dependenciesChanged(task)).invalidated, [e2.id], "a second state change is looked at too");
    } finally { await x.w.close(); }
  });

  test(`${backend.name}: an approval made before dependencies were kept is judged against an entry observed at the same millisecond (fail closed) (card Q02 review)`, async () => {
    const x = await world(backend);
    try {
      const { owner, task, plant, desk, deskBody, svc, code, deps } = x;
      await deps.record(owner, { commandId: cid("d"), taskId: task, dependencies: [{ kind: "record", key: desk, hash: sha("spec v1") }] });
      await x.review("approve");
      const verdicts = await x.raw("submission-verdicts", code.id);
      const last = verdicts.reviews[verdicts.reviews.length - 1];
      // Same millisecond as the entry's observation (clock unchanged), with no dependency basis kept.
      await plant("submission-verdicts", code.id, { reviews: [...verdicts.reviews.slice(0, -1), { ...last, basis: { criteriaRevision: last.basis.criteriaRevision, decisions: last.basis.decisions } }] });
      assert.equal((await svc.approvalOf(code.id))?.approved, true);
      await plant("desk-record", desk, deskBody("spec v2"));
      assert.equal((await svc.approvalOf(code.id))?.approved, false, "an entry observed at the same millisecond is judged");
    } finally { await x.w.close(); }
  });
}
