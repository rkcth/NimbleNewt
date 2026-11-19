import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { acceptedArgs, CHAT_OPS, ScriptedInterpreter } from "../chat/index.js";
import type { EnvironmentFacts, FilesystemDetector } from "../environment/index.js";
import { PI } from "../dispatch/testing/world.js";
import { startController } from "./index.js";

const ext4: FilesystemDetector = async () => ({ type: "ext4", network: false });
const supported: EnvironmentFacts = { platform: "linux", arch: "x64", osRelease: "6.8.0-generic", nodeVersion: "22.19.0" };
const base = "a".repeat(40), tree = "b".repeat(40), patch = "c".repeat(40);

// Card P10 (queue slice), through the composed controller: a reviewer's approval puts the submission in the landing queue by itself and a later "changes" takes it out; the queue is read, added to and
// taken from through the state API with its rights; an integrator lands only the queued task; the owner takes a task's work out of the queue by chat, shown first.
test("the landing queue through the state API and chat: queued on approval, withdrawn on changes, landed oldest first (card P10)", async () => {
  const d = mkdtempSync(join(tmpdir(), "nn-p10q-"));
  const say: Record<string, unknown[]> = {};
  const c = await startController({ storage: { kind: "sqlite", path: join(d, "c.sqlite") }, argv: [], env: {}, print: () => undefined, facts: supported, filesystem: ext4, features: [], harnesses: [PI], chat: { interpreter: new ScriptedInterpreter((input) => say[input.text] ?? []) } } as never);
  try {
    const s = c.services;
    const boot = await s.principals.bootstrapOwner({ name: "rob" });
    const rob = await s.principals.authenticate(boot.token);
    const O = boot.token;
    const project = (await s.projects.createProject({ commandId: "p1", actor: rob.id, name: "Garden" })).id;
    const call = (token: string, op: string, args: Record<string, unknown>, commandId?: string) => c.api.handle(token, { v: 1, op, ...(commandId === undefined ? {} : { commandId }), args } as never) as Promise<any>;
    const hire = async (name: string, roles: string[], more: { action: string; project: string }[] = []) => {
      const made = await s.agents.create(rob, { commandId: `mk-${name}`, friendlyName: name, roles });
      const id = `agent:${made.id}`;
      for (const [i, g] of [{ action: "task.read", project }, ...more].entries()) await s.grants.grant(rob, { commandId: `g-${name}-${i}`, grantee: id, action: g.action, project: g.project, source: "direct", basis: "test" } as never);
      return { id, agentId: made.id, token: (await s.principals.issueCredential(rob, id)).token };
    };
    const ann = await hire("Ann", ["author"]);
    const rev = await hire("Rev", ["reviewer"]);
    const ivy = await hire("Ivy", ["integrator"], [{ action: "integration.lease", project }, { action: "workspace.manage", project }]);
    const submit = async (title: string, n: string) => {
      const task = (await s.projects.createTask({ commandId: `t-${n}`, actor: rob.id, projectId: project, title })).id;
      await s.projects.transitionTask({ commandId: `r-${n}`, actor: rob.id, taskId: task, expectedRevision: 1, to: "ready" });
      await s.assignments.assignTask({ commandId: `as-${n}`, actor: rob.id, taskId: task, owner: { kind: "agent", id: ann.id } } as never);
      await s.assignments.admitAttempt({ commandId: `adm-${n}`, actor: rob.id, taskId: task, expectedRevision: (await s.assignments.getAssignment(task))!.revision, generation: 1, owner: { kind: "agent", id: ann.id }, harness: "pi" } as never);
      const made = await call(ann.token, "submission.record", { taskId: task, kind: "code", role: "author", base, tree, patchId: patch }, `code-${n}`);
      assert.equal(made.ok, true, JSON.stringify(made));
      return { task, id: made.result.id as string };
    };
    const review = (subject: string, verdict: string, n: string) => call(rev.token, "submission.record", { taskId: subjects.get(subject)!, kind: "review", role: "reviewer", subject, verdict }, `rev-${n}`);
    const subjects = new Map<string, string>();
    const queue = async () => ((await call(O, "landing.queue.list", { projectId: project })).result.items as any[]).map((e) => [e.position, e.submissionId]);

    // Approved while the project names no landing branch: not queued (nothing to queue on); added by hand later.
    const one = await submit("One", "1"); subjects.set(one.id, one.task);
    assert.ok((await review(one.id, "approve", "1")).ok);
    assert.deepEqual(await queue(), []);
    assert.ok((await call(O, "project.branches.change", { project, landing: "main" }, "lb1")).ok);
    const added = await call(ann.token, "landing.queue.add", { submissionId: one.id }, "qa1");
    assert.equal(added.ok, true, JSON.stringify(added));
    assert.deepEqual([added.result.position, added.result.branch], [1, "main"]);
    // Approved now: queued by the controller itself, behind the first.
    const two = await submit("Two", "2"); subjects.set(two.id, two.task);
    assert.equal((await call(ivy.token, "landing.queue.add", { submissionId: two.id }, "qi0")).error?.code, "review_invalid", "not approved yet");
    assert.ok((await review(two.id, "approve", "2")).ok);
    assert.deepEqual(await queue(), [[1, one.id], [2, two.id]]);
    // Rights: an author does not read the queue; the integrator does; a stranger is told nothing exists.
    assert.equal((await call(ann.token, "landing.queue.list", { projectId: project })).error?.code, "not_found");
    assert.equal((await call(ivy.token, "landing.queue.list", { projectId: project })).result.branch, "main");
    assert.equal((await call(rev.token, "landing.queue.add", { submissionId: one.id }, "qr1")).error?.code, "not_found");
    // A later "changes" takes the approval back, and the submission out of the queue.
    assert.ok((await review(one.id, "changes", "3")).ok);
    assert.deepEqual(await queue(), [[1, two.id]]);
    assert.ok((await review(one.id, "approve", "4")).ok);
    assert.deepEqual(await queue(), [[1, two.id], [2, one.id]], "approved again: queued again, at the back");

    // An integrator lands only the oldest queued task (no host on this controller: the landing passes the controller's checks and is refused for that reason).
    const lease = (await call(ivy.token, "integrator.lease.acquire", { taskId: two.task, branch: "main", ttlMs: 600_000 }, "li1")).result.item;
    const land = (taskId: string, id: string) => call(ivy.token, "workspace.request", { operation: "landing", taskId, reason: "land it", leaseId: lease.leaseId, fence: lease.fence }, id);
    assert.equal((await land(one.task, "w1")).error?.code, "invalid_transition", "not the oldest");
    const head = await land(two.task, "w2");
    assert.equal(head.error?.code, undefined, JSON.stringify(head));
    assert.match(head.result.summary, /no host/);
    assert.deepEqual(head.result.queued, { submissionId: two.id, base, tree, branch: "main" });
    assert.deepEqual(await queue(), [[1, two.id], [2, one.id]], "nothing landed, nothing left the queue");

    // Chat: the owner takes a task's work out of the queue in plain words; shown first, applied on the owner's word.
    assert.equal(CHAT_OPS["landing.queue.remove"]?.mode, "propose");
    assert.ok(acceptedArgs("landing.queue.remove")!.includes("taskId") && acceptedArgs("landing.queue.remove")!.includes("reason"));
    await c.chat!.setFocus(O, { commandId: "f1", projectId: project });
    const text = "task Two should not land next, take it out of the landing queue, it needs another look";
    say[text] = [{ kind: "command", op: "landing.queue.remove", args: { taskId: two.task, reason: "it needs another look" }, evidence: text, basis: "owner" }];
    const out = (await c.chat!.submit(O, { messageId: "m1", text })).outcomes;
    assert.equal(out[0]!.status, "proposed", JSON.stringify(out));
    assert.deepEqual(await queue(), [[1, two.id], [2, one.id]], "nothing happens until the owner agrees");
    say["yes, go ahead"] = [{ kind: "apply_proposal", proposalId: out[0]!.proposalId, evidence: "yes, go ahead", basis: "owner" }];
    const applied = (await c.chat!.submit(O, { messageId: "m2", text: "yes, go ahead" })).outcomes;
    assert.equal(applied[0]!.status, "applied", JSON.stringify(applied));
    assert.deepEqual(await queue(), [[1, one.id]]);
  } finally { await c.close(); rmSync(d, { recursive: true, force: true }); }
});
