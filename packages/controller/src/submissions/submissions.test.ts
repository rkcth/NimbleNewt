import assert from "node:assert/strict";
import { after, test } from "node:test";
import { DomainError, type DomainErrorCode } from "../domain/errors.js";
import { ProjectService } from "../domain/service.js";
import { backends, stopServer } from "../domain/testing/backends.js";
import { PrincipalService, type Principal } from "../security/index.js";
import { SubmissionService, type SubmissionOptions } from "./index.js";

after(stopServer);

const options = { clock: () => "2026-10-30T10:00:00.000Z", pause: async () => undefined };
let n = 0;
const cid = (label: string): string => `${label}-${n++}`;
const refuses = async (code: DomainErrorCode, run: () => Promise<unknown>, match?: RegExp): Promise<void> => {
  await assert.rejects(run, (error: unknown) => { assert.ok(error instanceof DomainError, String(error)); assert.equal(error.code, code, error.message); if (match) assert.match(error.message, match); return true; });
};
const T1 = "a".repeat(40), T2 = "b".repeat(40), BASE = "c".repeat(40), PATCH = "d".repeat(40);
const DIGEST = `sha256:${"e".repeat(64)}`;
const OWN = /^agent:/;
const pass = (boundTo: string) => [{ check: "tests", result: "pass" as const, boundTo }];

for (const backend of backends) {
  const suite = (name: string, body: (c: { open(roles: (id: string, scope: { projectId: string; taskId: string }) => Promise<readonly string[]>, extra?: SubmissionOptions): SubmissionService; other: { task: string }; rawBody(id: string): Promise<unknown>; svc: SubmissionService; roles: Map<string, string[]>; agent(name: string, roles: string[], granted?: boolean): Promise<Principal>; owner: Principal; task: string }) => Promise<void>) =>
    test(`${backend.name}: ${name}`, async () => {
      const world = await backend.open();
      try {
        const projects = await ProjectService.open(world.storage, { holder: "c1", ...options });
        const principals = PrincipalService.withEpoch(world.storage, projects.epoch, options);
        const owner = await principals.authenticate((await principals.bootstrapOwner({ name: "rob" })).token);
        const project = (await projects.createProject({ commandId: cid("p"), actor: owner.id, name: "P" })).id;
        const task = (await projects.createTask({ commandId: cid("t"), actor: owner.id, projectId: project, title: "T" })).id;
        const project2 = (await projects.createProject({ commandId: cid("p"), actor: owner.id, name: "Q" })).id;
        const task2 = (await projects.createTask({ commandId: cid("t"), actor: owner.id, projectId: project2, title: "T2" })).id;
        const roles = new Map<string, string[]>();
        const agent = async (nm: string, held: string[], granted = true): Promise<Principal> => {
          await principals.enroll(owner, { commandId: cid("e"), kind: "agent", name: nm, grants: granted ? [{ action: "task.read", project }, { action: "task.read", project: project2 }] : [] });
          const p = await principals.authenticate((await principals.issueCredential(owner, `agent:${nm}`)).token);
          roles.set(p.id, held);
          return p;
        };
        const svc = SubmissionService.withEpoch(world.storage, projects.epoch, async (id) => roles.get(id) ?? [], options);
        await body({ svc, roles, agent, owner, task, other: { task: task2 }, rawBody: async (id) => (await world.storage.getAggregate({ kind: "submission", id }))?.body, open: (r, extra = {}) => SubmissionService.withEpoch(world.storage, projects.epoch, r, { ...options, ...extra }) });
      } finally { await world.close(); }
    });

  suite("a role submits only its own kinds, and only a role the agent holds", async (c) => {
    const ann = await c.agent("ann", ["author"]);
    const code = { taskId: c.task, kind: "code" as const, role: "author", base: BASE, tree: T1, patchId: PATCH };
    const made = await c.svc.record(ann, { commandId: cid("s"), ...code, evidence: pass(T1) });
    assert.match(made.id, /^sbm-/);
    const got = await c.svc.get(ann, made.id);
    assert.equal(got?.kind, "code");
    assert.equal(got?.refreshRound, 0);
    assert.equal(got?.makesCommit, false);
    await refuses("forbidden", () => c.svc.record(ann, { commandId: cid("s"), taskId: c.task, kind: "qa", role: "author", subject: made.id, report: "x" }), /may not submit a qa/);
    await refuses("forbidden", () => c.svc.record(ann, { commandId: cid("s"), taskId: c.task, kind: "review", role: "reviewer", subject: made.id, verdict: "approve" }), /does not hold the role reviewer/);
    await refuses("forbidden", () => c.svc.record(ann, { commandId: cid("s"), ...code, role: "integrator" }));
    await refuses("forbidden", () => c.svc.record(c.owner, { commandId: cid("s"), ...code }), /not an agent/);
    // one agent holding two roles may submit in either, which keeps a one-agent project working
    c.roles.set(ann.id, ["author", "docs"]);
    await c.svc.record(ann, { commandId: cid("s"), taskId: c.task, kind: "document", role: "docs", artifactDigest: DIGEST, evidence: pass(DIGEST) });
  });

  suite("a code submission names base, tree and patch-id; a non-code one makes no commit", async (c) => {
    const ann = await c.agent("ann", ["author", "reviewer", "qa", "docs"]);
    const bob = await c.agent("bob", ["reviewer"]);
    for (const drop of ["base", "tree", "patchId"]) {
      const full: Record<string, unknown> = { taskId: c.task, kind: "code", role: "author", base: BASE, tree: T1, patchId: PATCH };
      delete full[drop];
      await refuses("invalid_command", () => c.svc.record(ann, { commandId: cid("s"), ...full } as never), new RegExp(drop));
    }
    await refuses("invalid_command", () => c.svc.record(ann, { commandId: cid("s"), taskId: c.task, kind: "code", role: "author", base: "main", tree: T1, patchId: PATCH }), /base/);
    const code = await c.svc.record(ann, { commandId: cid("s"), taskId: c.task, kind: "code", role: "author", base: BASE, tree: T1, patchId: PATCH, refreshRound: 2 });
    assert.equal((await c.svc.get(ann, code.id))?.refreshRound, 2);
    for (const extra of [{ tree: T1 }, { base: BASE }, { patchId: PATCH }]) {
      await refuses("invalid_command", () => c.svc.record(bob, { commandId: cid("s"), taskId: c.task, kind: "review", role: "reviewer", subject: code.id, verdict: "approve", ...extra }), /makes no commit/);
      await refuses("invalid_command", () => c.svc.record(ann, { commandId: cid("s"), taskId: c.task, kind: "document", role: "docs", artifactDigest: DIGEST, ...extra }), /makes no commit/);
    }
    const review = await c.svc.record(bob, { commandId: cid("s"), taskId: c.task, kind: "review", role: "reviewer", subject: code.id, verdict: "changes", evidence: pass(T1) });
    const stored = await c.svc.get(bob, review.id);
    assert.equal(stored?.tree, T1, "the verdict is about the exact tree and patch it was given");
    assert.equal(stored?.patchId, PATCH);
    assert.equal(stored?.makesCommit, false);
    await refuses("invalid_command", () => c.svc.record(bob, { commandId: cid("s"), taskId: c.task, kind: "review", role: "reviewer", subject: review.id, verdict: "approve" }), /code or document/);
    await refuses("invalid_command", () => c.svc.record(ann, { commandId: cid("s"), taskId: c.task, kind: "qa", role: "qa", report: "ok" }), /subject/);
  });

  suite("evidence for a different tree or artifact version is rejected", async (c) => {
    const ann = await c.agent("ann", ["author", "reviewer", "docs"]);
    const bob = await c.agent("bob", ["reviewer"]);
    await refuses("invalid_command", () => c.svc.record(ann, { commandId: cid("s"), taskId: c.task, kind: "code", role: "author", base: BASE, tree: T1, patchId: PATCH, evidence: pass(T2) }), /bound to b+, not to the submitted tree/);
    await refuses("invalid_command", () => c.svc.record(ann, { commandId: cid("s"), taskId: c.task, kind: "code", role: "author", base: BASE, tree: T1, patchId: PATCH, evidence: [...pass(T1), ...pass(T2)] }));
    const code = await c.svc.record(ann, { commandId: cid("s"), taskId: c.task, kind: "code", role: "author", base: BASE, tree: T1, patchId: PATCH, evidence: pass(T1) });
    await refuses("invalid_command", () => c.svc.record(bob, { commandId: cid("s"), taskId: c.task, kind: "review", role: "reviewer", subject: code.id, verdict: "approve", evidence: pass(T2) }), /not to the submitted tree/);
    await refuses("invalid_command", () => c.svc.record(ann, { commandId: cid("s"), taskId: c.task, kind: "document", role: "docs", artifactDigest: DIGEST, evidence: pass(T1) }), /artifact/);
    await refuses("invalid_command", () => c.svc.record(ann, { commandId: cid("s"), taskId: c.task, kind: "document", role: "docs", artifactDigest: DIGEST, evidence: [{ check: "x", result: "pass", boundTo: "latest" }] }), /boundTo/);
    // not_run is evidence too (it counts as failed at the gate, card P09), but it must still be bound to the exact tree
    await c.svc.record(ann, { commandId: cid("s"), taskId: c.task, kind: "code", role: "author", base: BASE, tree: T2, patchId: PATCH, evidence: [{ check: "lint", result: "not_run", boundTo: T2 }] });
  });

  suite("a director sign-off cannot be given on the director's own work", async (c) => {
    const ann = await c.agent("ann", ["author"]);
    const dee = await c.agent("dee", ["director", "author"]);
    const theirs = await c.svc.record(ann, { commandId: cid("s"), taskId: c.task, kind: "code", role: "author", base: BASE, tree: T1, patchId: PATCH });
    const mine = await c.svc.record(dee, { commandId: cid("s"), taskId: c.task, kind: "code", role: "author", base: BASE, tree: T2, patchId: PATCH });
    await refuses("forbidden", () => c.svc.record(dee, { commandId: cid("s"), taskId: c.task, kind: "signoff", role: "director", subject: mine.id, decision: "approve" }), /own work/);
    const ok = await c.svc.record(dee, { commandId: cid("s"), taskId: c.task, kind: "signoff", role: "director", subject: theirs.id, decision: "approve", evidence: pass(T1) });
    assert.equal((await c.svc.get(dee, ok.id))?.decision, "approve");
    await refuses("forbidden", () => c.svc.record(ann, { commandId: cid("s"), taskId: c.task, kind: "signoff", role: "director", subject: theirs.id, decision: "approve" }));
  });

  suite("a repeated command records once, a reused command ID with other content conflicts, reads are limited", async (c) => {
    const ann = await c.agent("ann", ["author"]);
    const bob = await c.agent("bob", ["author"]);
    const cmd = { commandId: "same-1", taskId: c.task, kind: "code" as const, role: "author", base: BASE, tree: T1, patchId: PATCH };
    const a = await c.svc.record(ann, cmd);
    const b = await c.svc.record(ann, cmd);
    assert.equal(a.id, b.id);
    await refuses("command_conflict", () => c.svc.record(ann, { ...cmd, tree: T2 }));
    assert.equal(await c.svc.get(bob, a.id), undefined);
    assert.equal((await c.svc.get(c.owner, a.id))?.submittedBy, ann.id);
    await refuses("invalid_command", () => c.svc.record(ann, { ...cmd, commandId: cid("s"), bogus: 1 } as never), /bogus/);
    await refuses("not_found", () => c.svc.record(ann, { ...cmd, commandId: cid("s"), taskId: "task-aaaaaaaaaaaaaaaaaaaa" }));
  });
  suite("a reviewer or qa agent cannot judge its own submission, and there is no flag to allow it", async (c) => {
    const ann = await c.agent("ann", ["author", "reviewer", "qa"]);
    const bob = await c.agent("bob", ["reviewer", "qa"]);
    const mine = await c.svc.record(ann, { commandId: cid("s"), taskId: c.task, kind: "code", role: "author", base: BASE, tree: T1, patchId: PATCH });
    await refuses("forbidden", () => c.svc.record(ann, { commandId: cid("s"), taskId: c.task, kind: "review", role: "reviewer", subject: mine.id, verdict: "approve" }), /own submission/);
    await refuses("forbidden", () => c.svc.record(ann, { commandId: cid("s"), taskId: c.task, kind: "qa", role: "qa", subject: mine.id, report: "fine" }), /own submission/);
    await c.svc.record(bob, { commandId: cid("s"), taskId: c.task, kind: "review", role: "reviewer", subject: mine.id, verdict: "approve" });
    // Even a service built to know of no other reviewer refuses it: there is no override.
    const solo = c.open(async (id) => c.roles.get(id) ?? [], { reviewersAvailableIn: async () => [] });
    await refuses("forbidden", () => solo.record(ann, { commandId: cid("s"), taskId: c.task, kind: "review", role: "reviewer", subject: mine.id, verdict: "approve" }), /own submission/);
  });

  suite("review is required of a code submission only while another agent could review it; otherwise the reason is recorded", async (c) => {
    const ann = await c.agent("ann", ["author", "reviewer"]);
    let others: string[] = [];
    const seen: string[] = [];
    const svc = c.open(async (id) => c.roles.get(id) ?? [], { reviewersAvailableIn: async (project, worker) => { seen.push(`${project}/${worker}`); return others; } });
    const code = (tree: string) => ({ taskId: c.task, kind: "code" as const, role: "author", base: BASE, tree, patchId: PATCH });
    const one = await svc.record(ann, { commandId: cid("s"), ...code(T1) });
    assert.deepEqual((await svc.get(ann, one.id))?.review, { required: false, reason: "review_disabled_single_agent" });
    assert.match(seen[0]!, new RegExp(`/${ann.id}$`));
    others = [ann.id]; // the worker never counts, even if a port names it
    assert.deepEqual((await svc.get(ann, (await svc.record(ann, { commandId: cid("s"), ...code(T2) })).id))?.review, { required: false, reason: "review_disabled_single_agent" });
    others = ["agent:bob"];
    const two = await svc.record(ann, { commandId: cid("s"), ...code("f".repeat(40)) });
    assert.deepEqual((await svc.get(ann, two.id))?.review, { required: true });
    assert.equal((await svc.get(ann, one.id))?.review?.required, false, "an earlier submission keeps what was recorded");
  });

  suite("roles are looked up for the task's project, so a role in one project is none in another", async (c) => {
    const ann = await c.agent("ann", []);
    const seen: string[] = [];
    const scoped = c.open(async (_id, scope) => { seen.push(`${scope.projectId}/${scope.taskId}`); return scope.taskId === c.task ? ["author"] : []; });
    const code = { kind: "code" as const, role: "author", base: BASE, tree: T1, patchId: PATCH };
    await scoped.record(ann, { commandId: cid("s"), taskId: c.task, ...code });
    await refuses("forbidden", () => scoped.record(ann, { commandId: cid("s"), taskId: c.other.task, ...code }), /in this project/);
    assert.equal(seen.length, 2);
    assert.match(seen[0]!, /^proj-[a-z2-7]{20}\/task-/);
  });

  suite("a code submission must come from the owner of the task's current attempt", async (c) => {
    const ann = await c.agent("ann", ["author"]);
    const bob = await c.agent("bob", ["author"]);
    const code = { kind: "code" as const, role: "author", base: BASE, tree: T1, patchId: PATCH, taskId: c.task };
    const roles = async (id: string): Promise<readonly string[]> => c.roles.get(id) ?? [];
    let attempt: { ownerId: string; state: string } | undefined;
    const gated = c.open(roles, { attemptOf: async () => attempt });
    await refuses("forbidden", () => gated.record(ann, { commandId: cid("s"), ...code }), /current attempt/);
    attempt = { ownerId: bob.id, state: "active" };
    await refuses("forbidden", () => gated.record(ann, { commandId: cid("s"), ...code }), /current attempt/);
    attempt = { ownerId: ann.id, state: "failed" };
    await refuses("forbidden", () => gated.record(ann, { commandId: cid("s"), ...code }), /current attempt/);
    attempt = { ownerId: ann.id, state: "active" };
    await gated.record(ann, { commandId: cid("s"), ...code });
    attempt = { ownerId: ann.id, state: "succeeded" };
    await gated.record(ann, { commandId: cid("s"), ...code, tree: T2 });
  });

  suite("formats are size-capped and checked: digests, evidence names, role, artifact ID", async (c) => {
    const ann = await c.agent("ann", ["author", "docs"]);
    const code = { taskId: c.task, kind: "code" as const, role: "author", base: BASE, tree: T1, patchId: PATCH };
    await refuses("invalid_command", () => c.svc.record(ann, { commandId: cid("s"), ...code, tree: "a".repeat(5000) }), /tree/);
    await refuses("invalid_command", () => c.svc.record(ann, { commandId: cid("s"), ...code, patchId: "d".repeat(65) }), /patchId/);
    await refuses("invalid_command", () => c.svc.record(ann, { commandId: cid("s"), ...code, base: `${"c".repeat(39)}Z` }), /base/);
    await refuses("invalid_command", () => c.svc.record(ann, { commandId: cid("s"), ...code, evidence: [{ check: "bad\nname", result: "pass", boundTo: T1 }] }), /evidence/);
    const long = "r".repeat(5000);
    await assert.rejects(() => c.svc.record(ann, { commandId: cid("s"), ...code, role: long }), (e: unknown) => { assert.ok(e instanceof DomainError); assert.ok(e.message.length < 300, "the echoed role is bounded"); return true; });
    await refuses("invalid_command", () => c.svc.record(ann, { commandId: cid("s"), taskId: c.task, kind: "document", role: "docs", artifactDigest: DIGEST, artifactId: "art-nope" }), /artifactId/);
    await refuses("invalid_command", () => c.svc.record(ann, { commandId: cid("s"), taskId: c.task, kind: "document", role: "docs", artifactDigest: `sha256:${"e".repeat(64)}${"e".repeat(5000)}` }), /artifactDigest/);
  });

  suite("a report is stored redacted, and a missing command ID is an invalid_command", async (c) => {
    const ann = await c.agent("ann", ["author"]);
    const bob = await c.agent("bob", ["qa", "docs"]);
    const code = await c.svc.record(ann, { commandId: cid("s"), taskId: c.task, kind: "code", role: "author", base: BASE, tree: T1, patchId: PATCH });
    const secret = "ghp_" + "A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q7r8";
    const qa = await c.svc.record(bob, { commandId: cid("s"), taskId: c.task, kind: "qa", role: "qa", subject: code.id, report: `token ${secret} leaked` });
    const doc = await c.svc.record(bob, { commandId: cid("s"), taskId: c.task, kind: "document", role: "docs", artifactDigest: DIGEST, report: `token ${secret}` });
    for (const id of [qa.id, doc.id]) {
      const raw = (await c.rawBody(id)) as { report: string };
      assert.ok(!raw.report.includes(secret), "the stored report holds no secret");
    }
    for (const bad of [undefined, "", 7, null]) await refuses("invalid_command", () => c.svc.record(ann, { commandId: bad, taskId: c.task, kind: "code", role: "author", base: BASE, tree: T1, patchId: PATCH } as never), /commandId/);
  });


  suite("listing a task's submissions: owner sees all, an agent its own, other tasks and projects are hidden, paged and filtered by kind", async (c) => {
    const ann = await c.agent("ann", ["author"]);
    const bob = await c.agent("bob", ["reviewer"]);
    const ids: string[] = [];
    for (let i = 0; i < 3; i++) ids.push((await c.svc.record(ann, { commandId: cid("s"), taskId: c.task, kind: "code", role: "author", base: BASE, tree: T1, patchId: PATCH, refreshRound: i })).id);
    const rev = await c.svc.record(bob, { commandId: cid("s"), taskId: c.task, kind: "review", role: "reviewer", subject: ids[0]!, verdict: "changes" });
    await c.svc.record(ann, { commandId: cid("s"), taskId: c.other.task, kind: "code", role: "author", base: BASE, tree: T2, patchId: PATCH });
    const all = await c.svc.list(c.owner, c.task, { limit: 50 });
    assert.deepEqual(all.items.map((x) => x.id), [...ids, rev.id].sort(), "the owner sees every record of this task and none of another task");
    assert.equal(all.next, undefined);
    // paging: pages are disjoint, ordered, and the cursor ends
    const seen: string[] = [];
    let after: string | undefined;
    for (let n = 0; n < 5; n++) {
      const p = await c.svc.list(c.owner, c.task, { limit: 2, ...(after === undefined ? {} : { afterId: after }) });
      assert.ok(p.items.length <= 2);
      seen.push(...p.items.map((x) => x.id));
      if (p.next === undefined) break;
      after = p.next;
    }
    assert.deepEqual(seen, all.items.map((x) => x.id));
    assert.deepEqual((await c.svc.list(c.owner, c.task, { kind: "review", limit: 50 })).items.map((x) => x.id), [rev.id]);
    // visibility: an agent sees only what it submitted
    assert.deepEqual((await c.svc.list(bob, c.task, { limit: 50 })).items.map((x) => x.id), [rev.id]);
    assert.equal((await c.svc.list(ann, c.task, { limit: 50 })).items.length, 3);
    // an agent without task.read in a task's project gets not_found, as does an unknown task
    const lone = await c.agent("lone", ["author"], false);
    await refuses("not_found", () => c.svc.list(lone, c.task, { limit: 5 }));
    await refuses("not_found", () => c.svc.list(c.owner, "task-aaaaaaaaaaaaaaaaaaaa", { limit: 5 }));
    await refuses("invalid_command", () => c.svc.list(c.owner, c.task, { limit: 0 }));
    await refuses("invalid_command", () => c.svc.list(c.owner, c.task, { limit: 101 }));
    await refuses("invalid_command", () => c.svc.list(c.owner, c.task, { limit: 5, kind: "nope" }));
    await refuses("invalid_command", () => c.svc.list(c.owner, c.task, { limit: 5, afterId: "zzz" }));
  });
}
