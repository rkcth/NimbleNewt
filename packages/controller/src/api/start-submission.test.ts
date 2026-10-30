import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { EnvironmentFacts, FilesystemDetector } from "../environment/index.js";
import { PI } from "../dispatch/testing/world.js";
import { startController } from "./index.js";

const ext4: FilesystemDetector = async () => ({ type: "ext4", network: false });
const supported: EnvironmentFacts = { platform: "linux", arch: "x64", osRelease: "6.8.0-generic", nodeVersion: "22.19.0" };
const sha = "a".repeat(40);
const tree = "b".repeat(40);
const patch = "c".repeat(40);

test("submissions by role go through the state API: the author submits code tied to its attempt, the reviewer approves it, self-review and another project's agent are refused, the owner reads, a stranger gets not_found, and a replay records once (card Q01b)", async () => {
  const d = mkdtempSync(join(tmpdir(), "nn-submission-"));
  const c = await startController({ storage: { kind: "sqlite", path: join(d, "c.sqlite") }, argv: [], env: {}, print: () => undefined, facts: supported, filesystem: ext4, features: [], harnesses: [PI] });
  try {
    const s = c.services;
    const boot = await s.principals.bootstrapOwner({ name: "rob" });
    const rob = await s.principals.authenticate(boot.token);
    const project = (await s.projects.createProject({ commandId: "p1", actor: rob.id, name: "Garden" })).id;
    const other = (await s.projects.createProject({ commandId: "p2", actor: rob.id, name: "Orchard" })).id;
    const task = (await s.projects.createTask({ commandId: "t1", actor: rob.id, projectId: project, title: "Dig" })).id;
    await s.projects.transitionTask({ commandId: "r1", actor: rob.id, taskId: task, expectedRevision: 1, to: "ready" });
    const hire = async (name: string, roles: string[], inProject: string) => {
      const made = await s.agents.create(rob, { commandId: `mk-${name}`, friendlyName: name, roles });
      const id = `agent:${made.id}`;
      await s.grants.grant(rob, { commandId: `g-${name}`, grantee: id, action: "task.read", project: inProject, source: "direct", basis: "test" } as never);
      return { id, token: (await s.principals.issueCredential(rob, id)).token };
    };
    const ann = await hire("Ann", ["author", "reviewer"], project);
    const rev = await hire("Rev", ["reviewer"], project);
    const far = await hire("Far", ["author", "reviewer"], other);
    const stranger = await hire("Nobody", ["author"], project);
    // Ann owns the task's attempt.
    await s.assignments.assignTask({ commandId: "as1", actor: rob.id, taskId: task, owner: { kind: "agent", id: ann.id } } as never);
    await s.assignments.admitAttempt({ commandId: "adm1", actor: rob.id, taskId: task, expectedRevision: (await s.assignments.getAssignment(task))!.revision, generation: 1, owner: { kind: "agent", id: ann.id }, harness: "pi" } as never);
    const call = (token: string, op: string, args: Record<string, unknown>, commandId?: string) => c.api.handle(token, { v: 1, op, ...(commandId === undefined ? {} : { commandId }), args } as never) as Promise<any>;
    const code = { taskId: task, kind: "code", role: "author", base: sha, tree, patchId: patch };

    assert.equal((await call(boot.token, "submission.record", code, "s0")).error.code, "forbidden", "the owner holds no role");
    assert.equal((await call(far.token, "submission.record", code, "sf")).error.code, "not_found", "another project's agent cannot see the task");
    assert.equal((await call(stranger.token, "submission.record", code, "sx")).error.code, "forbidden", "an agent that does not own the attempt cannot submit code");
    assert.equal((await call(ann.token, "submission.record", { ...code, role: "qa" }, "sr")).error.code, "forbidden", "a role the agent does not hold (or that may not submit code)");
    assert.equal((await call(ann.token, "submission.record", code)).error.code, "invalid_command", "a command ID is required");

    const first = await call(ann.token, "submission.record", { ...code, evidence: [{ check: "unit", result: "pass", boundTo: tree }] }, "s1");
    assert.equal(first.ok, true, JSON.stringify(first));
    const id = first.result.id as string;
    assert.equal(first.result.replayed, false);
    const again = await call(ann.token, "submission.record", { ...code, evidence: [{ check: "unit", result: "pass", boundTo: tree }] }, "s1");
    assert.deepEqual([again.result.id, again.result.replayed], [id, true], "a replay records once");

    const approve = await call(rev.token, "submission.record", { taskId: task, kind: "review", role: "reviewer", subject: id, verdict: "approve" }, "s2");
    assert.equal(approve.ok, true, JSON.stringify(approve));
    const reviewId = approve.result.id as string;
    // Self-review: Ann holds the reviewer role too, and still may not review her own work.
    assert.equal((await call(ann.token, "submission.record", { taskId: task, kind: "review", role: "reviewer", subject: id, verdict: "approve" }, "s3")).error.code, "forbidden", "self-review is refused");

    const got = await call(boot.token, "submission.get", { submissionId: id });
    assert.equal(got.ok, true, JSON.stringify(got));
    assert.deepEqual([got.result.item.kind, got.result.item.tree, got.result.item.submittedBy], ["code", tree, ann.id]);
    const review = await call(boot.token, "submission.get", { submissionId: reviewId });
    assert.deepEqual([review.result.item.verdict, review.result.item.tree], ["approve", tree], "the verdict is bound to the tree it was given");
    assert.equal((await call(ann.token, "submission.get", { submissionId: id })).ok, true, "the submitter reads its own");
    assert.equal((await call(stranger.token, "submission.get", { submissionId: id })).error.code, "not_found");
    assert.equal((await call(far.token, "submission.get", { submissionId: id })).error.code, "not_found");
    assert.equal((await call(boot.token, "submission.get", { submissionId: id, extra: 1 })).error.code, "invalid_command");
  } finally { await c.close(); rmSync(d, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }); }
});

test("review is disabled for a project with one agent (the reason is recorded on the submission, self-review stays refused) and turns back on for new submissions when a second agent joins (owner decision, final)", async () => {
  const d = mkdtempSync(join(tmpdir(), "nn-submission-solo-"));
  const c = await startController({ storage: { kind: "sqlite", path: join(d, "c.sqlite") }, argv: [], env: {}, print: () => undefined, facts: supported, filesystem: ext4, features: [], harnesses: [PI] });
  try {
    const s = c.services;
    const boot = await s.principals.bootstrapOwner({ name: "rob" });
    const rob = await s.principals.authenticate(boot.token);
    const project = (await s.projects.createProject({ commandId: "p1", actor: rob.id, name: "Garden" })).id;
    const task = (await s.projects.createTask({ commandId: "t1", actor: rob.id, projectId: project, title: "Dig" })).id;
    await s.projects.transitionTask({ commandId: "r1", actor: rob.id, taskId: task, expectedRevision: 1, to: "ready" });
    const hire = async (name: string, roles: string[]) => {
      const made = await s.agents.create(rob, { commandId: `mk-${name}`, friendlyName: name, roles });
      const id = `agent:${made.id}`;
      await s.grants.grant(rob, { commandId: `g-${name}`, grantee: id, action: "task.read", project, source: "direct", basis: "test" } as never);
      return { id, token: (await s.principals.issueCredential(rob, id)).token };
    };
    const ann = await hire("Ann", ["author", "reviewer"]);
    await s.assignments.assignTask({ commandId: "as1", actor: rob.id, taskId: task, owner: { kind: "agent", id: ann.id } } as never);
    await s.assignments.admitAttempt({ commandId: "adm1", actor: rob.id, taskId: task, expectedRevision: (await s.assignments.getAssignment(task))!.revision, generation: 1, owner: { kind: "agent", id: ann.id }, harness: "pi" } as never);
    const call = (token: string, op: string, args: Record<string, unknown>, commandId?: string) => c.api.handle(token, { v: 1, op, ...(commandId === undefined ? {} : { commandId }), args } as never) as Promise<any>;
    const code = { taskId: task, kind: "code", role: "author", base: sha, tree, patchId: patch };

    const solo = await call(ann.token, "submission.record", code, "s1");
    assert.equal(solo.ok, true, JSON.stringify(solo));
    const soloId = solo.result.id as string;
    assert.deepEqual((await call(boot.token, "submission.get", { submissionId: soloId })).result.item.review, { required: false, reason: "review_disabled_single_agent" }, "recorded, not silent");
    assert.equal((await call(ann.token, "submission.record", { taskId: task, kind: "review", role: "reviewer", subject: soloId, verdict: "approve" }, "s2")).error.code, "forbidden", "never reviews its own work");

    // A second agent turns review on for NEW submissions; the earlier record is unchanged.
    const bob = await hire("Bob", ["reviewer"]);
    const next = await call(ann.token, "submission.record", { ...code, tree: "d".repeat(40) }, "s3");
    assert.equal(next.ok, true, JSON.stringify(next));
    assert.deepEqual((await call(boot.token, "submission.get", { submissionId: next.result.id })).result.item.review, { required: true });
    assert.equal((await call(boot.token, "submission.get", { submissionId: soloId })).result.item.review.required, false);
    assert.equal((await call(ann.token, "submission.record", { taskId: task, kind: "review", role: "reviewer", subject: next.result.id, verdict: "approve" }, "s4")).error.code, "forbidden");
    const ok = await call(bob.token, "submission.record", { taskId: task, kind: "review", role: "reviewer", subject: next.result.id, verdict: "approve" }, "s5");
    assert.equal(ok.ok, true, JSON.stringify(ok));
  } finally { await c.close(); rmSync(d, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }); }
});
