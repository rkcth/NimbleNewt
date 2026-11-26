// Card Q02 (finish, second review): cases the first review did not cover, on all four storage backends.
// - An entry whose recorder may not read what it names (`unverified`) keeps no acknowledgement and is not judged from the controller's state, so a recorder learns nothing about such a record from the manifest,
//   a refusal or a reason (whether a guessed hash matches it, whether a looked-up record exists).
// - A reason names a shared record, catalog version or lookup by its manifest entry, never by its key.
// - The re-review cause leaves out the time an observation was recorded, so an observation recorded back and forth stays one reason with bounded episodes.
// - One read of the QA gate judges each recorded dependency once, however many evidence records were judged against it.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { after, test } from "node:test";
import { derivedId } from "../domain/ids.js";
import { CommandRunner } from "../domain/runner.js";
import { ProjectService } from "../domain/service.js";
import { backends, stopServer } from "../domain/testing/backends.js";
import { DependencyService } from "../dependencies/index.js";
import { PrincipalService, type Principal } from "../security/index.js";
import type { ControllerStorage, JsonObject } from "../storage/types.js";
import { dependencyChangeText } from "./dependency-basis.js";
import { QaEvidenceService, QaReviewService, SubmissionService } from "./index.js";

after(stopServer);

let clock = "2026-11-26T10:00:00.000Z";
const options = { clock: () => clock, pause: async () => undefined };
let n = 0;
const cid = (label: string): string => `${label}-${n++}`;
const sha = (v: string): string => createHash("sha256").update(v).digest("hex");
const T1 = "a".repeat(40), BASE = "c".repeat(40), PATCH = "d".repeat(40);

async function world(backend: (typeof backends)[number]) {
  const w = await backend.open();
  let deskReads = 0;
  // Counts the reads of desk records made through it (the QA service's), so a test can tell how often one is judged.
  const counted = new Proxy(w.storage, { get(t, p) { const v = Reflect.get(t, p) as unknown; if (p === "getAggregate") return (ref: { kind: string }, ...rest: unknown[]) => { if (ref.kind === "desk-record") deskReads++; return (v as (...a: unknown[]) => unknown).call(t, ref, ...rest); }; return typeof v === "function" ? (v as (...a: unknown[]) => unknown).bind(t) : v; } }) as ControllerStorage;
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
  const agent = async (nm: string, held: string[], grants: { action: string; project: string }[] = [{ action: "task.read", project }]): Promise<Principal> => {
    await principals.enroll(owner, { commandId: cid("e"), kind: "agent", name: nm, grants });
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
  // Works the task, and may not read the project's desk records.
  const wrk = await agent("wrk", ["author"], [{ action: "task.read", project }, { action: "attempt.work", project }]);
  const svc = SubmissionService.withEpoch(w.storage, projects.epoch, async (id) => roles.get(id) ?? [], options);
  const qa = QaEvidenceService.withEpoch(counted, projects.epoch, { rolesOf: async (id) => roles.get(id) ?? [] }, options);
  const deps = DependencyService.withEpoch(w.storage, projects.epoch, { ...options, recorded: async (t) => { await qa.dependenciesChanged(t); } });
  const code = await svc.record(ann, { commandId: cid("s"), taskId: task, kind: "code", role: "author", base: BASE, tree: T1, patchId: PATCH });
  const review = (verdict: string) => svc.record(rev, { commandId: cid("rv"), taskId: task, kind: "review", role: "reviewer", subject: code.id, verdict } as never);
  const evidence = () => qa.record(qaAgent, { commandId: cid("qe"), submissionId: code.id, criteriaRevision: 1, environment: "linux", observedAt: "2026-11-26T09:30:00.000Z", checks: [{ name: "unit", result: "passed" }] });
  return { w, projects, owner, project, task, plant, raw, desk, deskBody, wrk, rev, svc, qa, deps, code, review, evidence, deskReads: () => deskReads };
}

for (const backend of backends) {
  test(`${backend.name}: an entry its recorder may not read keeps no acknowledgement and is not judged from the controller's state, whatever hash was guessed (card Q02 second review)`, async () => {
    const x = await world(backend);
    try {
      const { wrk, task, desk, deps, svc, code } = x;
      const entry = async (): Promise<any> => (await deps.get(wrk, task))!.entries.find((e) => e.key === desk || e.key === `desk-record:${desk}`);
      // A wrong guess and the right one read the same apart from the hash: no `seen` on either, and nothing refused.
      await deps.record(wrk, { commandId: cid("d"), taskId: task, dependencies: [{ kind: "record", key: desk, hash: sha("a guess") }] });
      const wrong = await entry();
      assert.deepEqual([wrong.unverified, wrong.seen], [true, undefined]);
      await x.review("approve");
      await x.evidence();
      assert.equal((await svc.approvalOf(code.id))?.approved, true, "an unverified hash does not take an approval back");
      await deps.record(wrk, { commandId: cid("d"), taskId: task, dependencies: [{ kind: "record", key: desk, hash: sha("spec v1") }] });
      const right = await entry();
      assert.deepEqual([right.unverified, right.seen], [true, undefined]);
      // A negative lookup of a record that exists, by one who may not read it: the same.
      await deps.record(wrk, { commandId: cid("d"), taskId: task, dependencies: [{ kind: "negative", key: `desk-record:${desk}` }] });
      const looked = (await deps.get(wrk, task))!.entries.find((e) => e.kind === "negative")!;
      assert.deepEqual([looked.unverified, looked.seen], [true, undefined]);
      await x.review("approve");
      await x.evidence();
      assert.equal((await svc.approvalOf(code.id))?.approved, true);
      // The shared record changes: the unverified entries take nothing back (recording another observation still does).
      await x.plant("desk-record", desk, x.deskBody("spec v2", "superseded"));
      assert.equal((await svc.approvalOf(code.id))?.approved, true, JSON.stringify(await svc.approvalOf(code.id)));
      assert.equal((await x.qa.gate(x.owner, code.id)).verdict, "passed");
    } finally { await x.w.close(); }
  });

  test(`${backend.name}: a reason names a shared record, a catalog version or a lookup by its manifest entry, not its key; a file by its path (card Q02 second review)`, async () => {
    const id = derivedId("dpm", "record||dsk-secretname");
    assert.equal(dependencyChangeText({ entryId: id, kind: "record", key: "dsk-secretname", status: "changed", detail: "the record was superseded" }), `the task's recorded record dependency (entry ${id}) changed (the record was superseded)`);
    for (const kind of ["decision", "tool-version", "negative"]) assert.doesNotMatch(dependencyChangeText({ entryId: "dpm-x", kind, key: "secret-key-words", status: "changed", detail: "d" }), /secret-key-words/);
    assert.match(dependencyChangeText({ entryId: "dpm-x", kind: "file", key: "src/a.ts", status: "re-recorded", detail: "was recorded again" }), /file dependency "src\/a\.ts" was recorded again/);
    void backend;
  });

  test(`${backend.name}: an observation recorded back and forth stays one reason: its re-reviews are episodes of one cause, not a new cause per recording time (card Q02 second review)`, async () => {
    const x = await world(backend);
    try {
      const { owner, task, project, svc, qa, deps, code } = x;
      const sched = QaReviewService.withEpoch(x.w.storage, x.projects.epoch, qa, { reviewers: async () => [x.rev.id], approvalOf: (id: string) => svc.approvalOf(id), dependenciesChanged: (t: string) => qa.dependenciesChanged(t) }, options);
      const file = (h: string) => deps.record(owner, { commandId: cid("d"), taskId: task, dependencies: [{ kind: "file", key: "src/a.ts", hash: h }] });
      await file(sha("one"));
      await x.review("approve");
      const requests: any[] = [];
      for (const [i, at] of ["10:05", "10:15"].entries()) {
        clock = `2026-11-26T${at}:00.000Z`;
        await file(sha("two"));
        await sched.sweep();
        const open = (await sched.requests(owner, project)).items;
        assert.equal(open.length, 1, `round ${i}`);
        requests.push(await x.raw("qa-review-request", open[0]!.id));
        // Recorded back to what was approved: the approval counts again and the request is settled as restored.
        clock = `2026-11-26T${at}:30.000Z`;
        await file(sha("one"));
        assert.equal((await svc.approvalOf(code.id))?.approved, true);
        await sched.sweep();
        assert.equal((await sched.requests(owner, project)).total, 0);
      }
      assert.notEqual(requests[0].reason, requests[1].reason, "the words name each recording time");
      assert.equal(requests[1].cause, requests[0].cause, "the cause does not");
    } finally { await x.w.close(); clock = "2026-11-26T10:00:00.000Z"; }
  });

  test(`${backend.name}: one read of the QA gate judges each recorded dependency once, however many evidence records were judged against it (card Q02 second review)`, async () => {
    const x = await world(backend);
    try {
      const { owner, task, desk, deps, qa, code } = x;
      await deps.record(owner, { commandId: cid("d"), taskId: task, dependencies: [{ kind: "record", key: desk, hash: sha("spec v1") }] });
      for (let i = 0; i < 5; i++) await x.evidence();
      const before = x.deskReads();
      assert.equal((await qa.gate(owner, code.id)).verdict, "passed");
      assert.equal(x.deskReads() - before, 1, "the record is read once for five evidence records");
    } finally { await x.w.close(); }
  });
}
