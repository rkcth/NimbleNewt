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
const base = "a".repeat(40), tree = "b".repeat(40), patch = "c".repeat(40);

// Card P10 (hand-off), through the composed controller: the landing queue's door reads the task's holder from the real assignment, so after the owner hands a task to another agent the new holder takes the
// task's queued work out and puts it back through the state API, and the agent that handed it off is told nothing exists; once the task is released, its author may again.
test("after a hand-off the task's new holder answers for its queued work through the state API (card P10)", async () => {
  const d = mkdtempSync(join(tmpdir(), "nn-p10h-"));
  const c = await startController({ storage: { kind: "sqlite", path: join(d, "c.sqlite") }, argv: [], env: {}, print: () => undefined, facts: supported, filesystem: ext4, features: [], harnesses: [PI] } as never);
  try {
    const s = c.services;
    const boot = await s.principals.bootstrapOwner({ name: "rob" });
    const rob = await s.principals.authenticate(boot.token);
    const O = boot.token;
    const project = (await s.projects.createProject({ commandId: "p1", actor: rob.id, name: "Garden" })).id;
    const call = (token: string, op: string, args: Record<string, unknown>, commandId?: string) => c.api.handle(token, { v: 1, op, ...(commandId === undefined ? {} : { commandId }), args } as never) as Promise<any>;
    const hire = async (name: string, roles: string[]) => {
      const made = await s.agents.create(rob, { commandId: `mk-${name}`, friendlyName: name, roles });
      const id = `agent:${made.id}`;
      await s.grants.grant(rob, { commandId: `g-${name}`, grantee: id, action: "task.read", project, source: "direct", basis: "test" } as never);
      return { id, agentId: made.id, token: (await s.principals.issueCredential(rob, id)).token };
    };
    const ann = await hire("Ann", ["author"]);
    const bob = await hire("Bob", ["author"]);
    const rev = await hire("Rev", ["reviewer"]);
    assert.ok((await call(O, "project.branches.change", { project, landing: "main" }, "lb1")).ok);
    const task = (await s.projects.createTask({ commandId: "t-1", actor: rob.id, projectId: project, title: "One" })).id;
    await s.projects.transitionTask({ commandId: "r-1", actor: rob.id, taskId: task, expectedRevision: 1, to: "ready" });
    // Assigned the way the dispatcher's inbox records it: the owner's ID is the agent's bare ID.
    await s.assignments.assignTask({ commandId: "as-1", actor: rob.id, taskId: task, owner: { kind: "agent", id: ann.agentId } } as never);
    await s.assignments.admitAttempt({ commandId: "adm-1", actor: rob.id, taskId: task, expectedRevision: (await s.assignments.getAssignment(task))!.revision, generation: 1, owner: { kind: "agent", id: ann.agentId }, harness: "pi" } as never);
    const made = await call(ann.token, "submission.record", { taskId: task, kind: "code", role: "author", base, tree, patchId: patch }, "code-1");
    assert.equal(made.ok, true, JSON.stringify(made));
    const sid = made.result.id as string;
    assert.ok((await call(rev.token, "submission.record", { taskId: task, kind: "review", role: "reviewer", subject: sid, verdict: "approve" }, "rev-1")).ok);
    const queue = async () => ((await call(O, "landing.queue.list", { projectId: project })).result.items as any[]).map((e) => [e.submissionId, e.author]);
    assert.deepEqual(await queue(), [[sid, ann.id]], "queued by the controller on approval");
    // While Ann holds the task, Bob may not touch its work.
    assert.equal((await call(bob.token, "landing.queue.remove", { taskId: task, reason: "not mine yet" }, "b0")).error?.code, "not_found");

    // The owner hands the task to Bob.
    await s.assignments.transferTask({ commandId: "tr-1", actor: rob.id, taskId: task, expectedRevision: (await s.assignments.getAssignment(task))!.revision, to: { kind: "agent", id: bob.agentId }, reason: "Ann moves to other work" } as never);
    assert.equal((await call(ann.token, "landing.queue.remove", { taskId: task, reason: "handed off" }, "a1")).error?.code, "not_found");
    const out = await call(bob.token, "landing.queue.remove", { taskId: task, reason: "I will look at it first" }, "b1");
    assert.equal(out.ok, true, JSON.stringify(out));
    assert.equal(out.result.removed.submissionId, sid);
    assert.deepEqual(await queue(), []);
    assert.equal((await call(ann.token, "landing.queue.add", { submissionId: sid }, "a2")).error?.code, "not_found");
    const back = await call(bob.token, "landing.queue.add", { submissionId: sid }, "b2");
    assert.equal(back.ok, true, JSON.stringify(back));
    assert.deepEqual(await queue(), [[sid, ann.id]], "the entry still names who submitted it");

    // Released: nobody holds the task, so its author answers for the work again and Bob no longer does.
    await s.assignments.releaseTask({ commandId: "rel-1", actor: rob.id, taskId: task, expectedRevision: (await s.assignments.getAssignment(task))!.revision } as never);
    assert.equal((await call(bob.token, "landing.queue.remove", { taskId: task, reason: "released" }, "b3")).error?.code, "not_found");
    assert.equal((await call(ann.token, "landing.queue.remove", { taskId: task, reason: "withdrawn by its author" }, "a3")).ok, true);
    assert.deepEqual(await queue(), []);
  } finally { await c.close(); rmSync(d, { recursive: true, force: true }); }
});
