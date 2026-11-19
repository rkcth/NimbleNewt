import assert from "node:assert/strict";
import { after, test } from "node:test";
import { DomainError, type DomainErrorCode } from "../domain/errors.js";
import { ProjectService } from "../domain/service.js";
import { backends, stopServer } from "../domain/testing/backends.js";
import { PrincipalService, type Principal } from "../security/index.js";
import { DOC_INDEX_KEPT, SubmissionService, docVerifyCode } from "./index.js";

after(stopServer);

let n = 0;
const cid = (label: string): string => `${label}-${n++}`;
const refuses = async (code: DomainErrorCode, run: () => Promise<unknown>, match?: RegExp): Promise<void> => {
  await assert.rejects(run, (error: unknown) => { assert.ok(error instanceof DomainError, String(error)); assert.equal(error.code, code, error.message); if (match) assert.match(error.message, match); return true; });
};
const digest = (c: string): string => `sha256:${c.repeat(64)}`;

for (const backend of backends) {
  test(`${backend.name}: the newest document submissions of a project are listed newest first from the project's index, read as submission.get reads them, paged and bounded (card Q03b)`, async () => {
    const world = await backend.open();
    // A moving clock: every write is one second later, so "since" and "newest" are about real record times.
    let tick = 0;
    const clock = (): string => new Date(Date.UTC(2026, 10, 19, 10, 0, tick++)).toISOString();
    const options = { clock, pause: async () => undefined };
    try {
      const projects = await ProjectService.open(world.storage, { holder: "c1", ...options });
      const principals = PrincipalService.withEpoch(world.storage, projects.epoch, options);
      const owner = await principals.authenticate((await principals.bootstrapOwner({ name: "rob" })).token);
      const project = (await projects.createProject({ commandId: cid("p"), actor: owner.id, name: "P" })).id;
      const other = (await projects.createProject({ commandId: cid("p"), actor: owner.id, name: "Q" })).id;
      const login = (await projects.createTask({ commandId: cid("t"), actor: owner.id, projectId: project, title: "Login" })).id;
      const search = (await projects.createTask({ commandId: cid("t"), actor: owner.id, projectId: project, title: "Search" })).id;
      const elsewhere = (await projects.createTask({ commandId: cid("t"), actor: owner.id, projectId: other, title: "X" })).id;
      const roles = new Map<string, string[]>();
      const agent = async (nm: string, held: string[], grants: { action: string; project: string }[]): Promise<Principal> => {
        await principals.enroll(owner, { commandId: cid("e"), kind: "agent", name: nm, grants });
        const p = await principals.authenticate((await principals.issueCredential(owner, `agent:${nm}`)).token);
        roles.set(p.id, held);
        return p;
      };
      const assigned = new Map<string, string[]>();
      const svc = SubmissionService.withEpoch(world.storage, projects.epoch, async (id) => roles.get(id) ?? [], { ...options, docIndexKept: 4, reviewAssignments: async (id, taskId) => assigned.get(`${id}|${taskId}`) ?? [] });
      const dora = await agent("dora", ["docs"], [{ action: "task.read", project }, { action: "task.read", project: other }]);
      const dan = await agent("dan", ["docs"], [{ action: "task.read", project }]);
      const rita = await agent("rita", ["reviewer"], [{ action: "task.read", project }]);
      const stranger = await agent("stranger", ["docs"], [{ action: "task.read", project: other }]);
      const doc = async (by: Principal, taskId: string, c: string, commandId = cid("d")): Promise<string> => (await svc.record(by, { commandId, taskId, kind: "document", role: "docs", artifactDigest: digest(c) })).id;

      assert.deepEqual((await svc.documents(owner, project, { limit: 10 })).items, [], "no document change yet");
      const d1 = await doc(dora, login, "1");
      const d2 = await doc(dan, search, "2");
      const mid = clock();
      const d3 = await doc(dora, login, "3");
      const far = await doc(dora, elsewhere, "4");
      // A code submission is not a document change and is not indexed.
      await svc.record(dora, { commandId: cid("x"), taskId: login, kind: "code", role: "author", base: "c".repeat(40), tree: "a".repeat(40), patchId: "d".repeat(40) }).catch(() => undefined);

      // The owner reads all of the project, newest first; another project's change is not among them.
      const all = await svc.documents(owner, project, { limit: 10 });
      assert.deepEqual(all.items.map((x) => x.id), [d3, d2, d1]);
      assert.equal(all.next, undefined);
      assert.ok(all.items[0]!.createdAt > all.items[1]!.createdAt, "createdAt is the record's time");
      assert.deepEqual(all.items.map((x) => x.artifactDigest), [digest("3"), digest("2"), digest("1")]);
      assert.deepEqual((await svc.documents(owner, other, { limit: 10 })).items.map((x) => x.id), [far]);
      // Since a time: only those recorded no earlier (a tie counts, as in doc.obligation.verify).
      assert.deepEqual((await svc.documents(owner, project, { limit: 10, since: mid })).items.map((x) => x.id), [d3]);
      const d3At = all.items[0]!.createdAt;
      assert.deepEqual((await svc.documents(owner, project, { limit: 10, since: d3At })).items.map((x) => x.id), [d3], "a change recorded at the flag time counts");

      // Paged: a cursor bound to the caller and the project.
      const first = await svc.documents(owner, project, { limit: 2 });
      assert.deepEqual(first.items.map((x) => x.id), [d3, d2]);
      assert.ok(first.next !== undefined);
      const second = await svc.documents(owner, project, { limit: 2, afterId: first.next! });
      assert.deepEqual(second.items.map((x) => x.id), [d1]);
      assert.equal(second.next, undefined);
      await refuses("invalid_command", () => svc.documents(dora, project, { limit: 2, afterId: first.next! }), /cursor/);
      await refuses("invalid_command", () => svc.documents(owner, other, { limit: 2, afterId: first.next! }), /cursor/);
      await refuses("invalid_command", () => svc.documents(owner, project, { limit: 51 }), /limit/);
      await refuses("invalid_command", () => svc.documents(owner, project, { limit: 5, since: "yesterday" }), /since/);

      // An agent sees exactly what submission.get lets it see: its own changes, and one it was asked to review.
      assert.deepEqual((await svc.documents(dora, project, { limit: 10 })).items.map((x) => x.id), [d3, d1]);
      assert.deepEqual((await svc.documents(dan, project, { limit: 10 })).items.map((x) => x.id), [d2]);
      // No next page is offered when what is left is nothing the caller may read, or nothing since the time asked (second review).
      assert.deepEqual(await svc.documents(dan, project, { limit: 1 }).then((r) => [r.items.map((x) => x.id), r.next]), [[d2], undefined], "d1 is left but dan may not read it");
      assert.deepEqual(await svc.documents(owner, project, { limit: 1, since: mid }).then((r) => [r.items.map((x) => x.id), r.next]), [[d3], undefined], "d2 and d1 are older than the time asked");
      assert.deepEqual((await svc.documents(rita, project, { limit: 10 })).items.map((x) => x.id), [], "a reviewer reads none it was not asked to review");
      assigned.set(`${rita.id}|${login}`, [d1]);
      assert.deepEqual((await svc.documents(rita, project, { limit: 10 })).items.map((x) => x.id), [d1]);
      for (const id of [d1]) assert.ok(await svc.get(rita, id), "the same rule as get");
      assert.equal(await svc.get(rita, d3), undefined);
      // No read right in the project: not found, like the project's other reads.
      await refuses("not_found", () => svc.documents(stranger, project, { limit: 10 }));
      await refuses("not_found", () => svc.documents(owner, "proj-aaaaaaaaaaaaaaaaaaaa", { limit: 10 }));
      // A task credential reads only its own task's changes, and nothing of another project.
      const scoped: Principal = { ...dora, taskScope: { taskId: search, projectId: project } };
      assert.deepEqual((await svc.documents(scoped, project, { limit: 10 })).items.map((x) => x.id), [], "dora made nothing in the search task");
      const scopedLogin: Principal = { ...dora, taskScope: { taskId: login, projectId: project } };
      assert.deepEqual((await svc.documents(scopedLogin, project, { limit: 10 })).items.map((x) => x.id), [d3, d1]);
      await refuses("not_found", () => svc.documents(scopedLogin, other, { limit: 10 }));

      // A repeat of the same command records once and is indexed once.
      const again = cid("d");
      const d4 = await doc(dora, login, "5", again);
      assert.equal(await doc(dora, login, "5", again), d4);
      assert.deepEqual((await svc.documents(owner, project, { limit: 10 })).items.map((x) => x.id), [d4, d3, d2, d1]);
      // Bounded: the index keeps the newest (4 here); the oldest drops off.
      const d5 = await doc(dan, search, "6");
      assert.deepEqual((await svc.documents(owner, project, { limit: 10 })).items.map((x) => x.id), [d5, d4, d3, d2]);
      assert.ok(await svc.get(owner, d1), "the record itself stays");
      // A cursor whose place drops out of the index is refused, not answered with an empty page (second review).
      const held = await svc.documents(owner, project, { limit: 3 });
      assert.deepEqual(held.items.map((x) => x.id), [d5, d4, d3]);
      assert.ok(held.next !== undefined);
      // Two document changes of one project at the same moment are both indexed (the one that lost the index write is built again).
      const [d6, d7, d8] = await Promise.all([doc(dora, login, "7"), doc(dan, search, "8"), doc(dora, search, "9")]);
      const newest = (await svc.documents(owner, project, { limit: 10 })).items.map((x) => x.id);
      assert.deepEqual(new Set(newest.slice(0, 3)), new Set([d6, d7, d8]));
      assert.deepEqual(newest.slice(3), [d5], "the index keeps the newest 4, in the order they were written");
      await refuses("invalid_command", () => svc.documents(owner, project, { limit: 3, afterId: held.next! }), /moved on/);
      // A burst: 20 document changes of one project at the same moment all succeed (before the index they never met; each lost index write is built again after a short wait), and the index keeps the newest.
      const burst = await Promise.allSettled(Array.from({ length: 20 }, (_, i) => doc(i % 2 === 0 ? dora : dan, i % 2 === 0 ? login : search, String.fromCharCode(97 + (i % 6)))));
      assert.deepEqual(burst.filter((r) => r.status === "rejected").map((r) => String((r as PromiseRejectedResult).reason)), [], "no document change of the burst fails");
      const burstIds = new Set(burst.map((r) => (r as PromiseFulfilledResult<string>).value));
      const kept = (await svc.documents(owner, project, { limit: 10 })).items.map((x) => x.id);
      assert.equal(kept.length, 4);
      assert.ok(kept.every((id) => burstIds.has(id)), "the newest 4 are from the burst");
    } finally { await world.close(); }
  });
}

test("the code a flagged document would be verified against: the newest flagged code, else the code it was last verified with unless that lost its QA gate (card Q03b)", () => {
  const verification = { documentSubmissionId: "sbm-aaaaaaaaaaaaaaaaaaaa", artifactDigest: digest("e"), version: "1", verifiedBy: "owner", verifiedAt: "x", evidence: [{ taskId: "task-a", submissionId: "sbm-old", tree: "t" }, { taskId: "task-b", submissionId: "sbm-bbb", tree: "t" }] };
  assert.deepEqual(docVerifyCode({ implementationRefs: ["task-a", "task-b"], verification }), { "task-a": "sbm-old", "task-b": "sbm-bbb" });
  assert.deepEqual(docVerifyCode({ implementationRefs: ["task-a", "task-b"], verification, reasons: [{ kind: "behavior_changed", taskId: "task-a", submissionId: "sbm-n1", tree: "t" }, { kind: "behavior_changed", taskId: "task-a", submissionId: "sbm-n2", tree: "t" }, { kind: "evidence_lost", taskId: "task-b", submissionId: "sbm-bbb" }] }), { "task-a": "sbm-n2" });
  assert.deepEqual(docVerifyCode({ implementationRefs: ["task-a"], reasons: [{ kind: "behavior_changed", taskId: "task-a", submissionId: "sbm-n1", tree: "t" }, { kind: "evidence_lost", taskId: "task-a", submissionId: "sbm-old" }] }), { "task-a": "sbm-n1" }, "lost evidence of the old code does not hide the newer flagged code");
  assert.deepEqual(docVerifyCode({ implementationRefs: ["task-a"], reasons: [{ kind: "release_changed", from: "1", to: "2" }] }), {});
  assert.ok(DOC_INDEX_KEPT >= 50);
});
