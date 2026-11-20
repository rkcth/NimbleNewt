import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { acceptedArgs, ScriptedInterpreter } from "../chat/index.js";
import type { EnvironmentFacts, FilesystemDetector } from "../environment/index.js";
import { PI } from "../dispatch/testing/world.js";
import { STATUS_KINDS } from "../status/index.js";
import { startController } from "./index.js";

const ext4: FilesystemDetector = async () => ({ type: "ext4", network: false });
const supported: EnvironmentFacts = { platform: "linux", arch: "x64", osRelease: "6.8.0-generic", nodeVersion: "22.19.0" };
const base = "a".repeat(40), tree = "b".repeat(40), patch = "c".repeat(40);

// Card P10, landing-queue polish, through the composed controller: after the owner names another landing branch, the owner sees in chat that the old branch's queue still holds work, reads it by name,
// and takes an entry out of it in plain words (shown first); the state API lists any branch and the other queues.
test("the owner reads the landing queues and clears an old branch's queue by chat after the landing branch changes (card P10, polish)", async () => {
  const d = mkdtempSync(join(tmpdir(), "nn-p10qp-"));
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
    const ivy = await hire("Ivy", ["integrator"], [{ action: "integration.lease", project }]);
    const submit = async (title: string, n: string) => {
      const task = (await s.projects.createTask({ commandId: `t-${n}`, actor: rob.id, projectId: project, title })).id;
      await s.projects.transitionTask({ commandId: `r-${n}`, actor: rob.id, taskId: task, expectedRevision: 1, to: "ready" });
      await s.assignments.assignTask({ commandId: `as-${n}`, actor: rob.id, taskId: task, owner: { kind: "agent", id: ann.id } } as never);
      await s.assignments.admitAttempt({ commandId: `adm-${n}`, actor: rob.id, taskId: task, expectedRevision: (await s.assignments.getAssignment(task))!.revision, generation: 1, owner: { kind: "agent", id: ann.id }, harness: "pi" } as never);
      const made = await call(ann.token, "submission.record", { taskId: task, kind: "code", role: "author", base, tree, patchId: patch }, `code-${n}`);
      assert.equal(made.ok, true, JSON.stringify(made));
      assert.ok((await call(rev.token, "submission.record", { taskId: task, kind: "review", role: "reviewer", subject: made.result.id, verdict: "approve" }, `rev-${n}`)).ok);
      return { task, id: made.result.id as string };
    };
    const turn = async (messageId: string, text: string, intents: unknown[]) => { say[text] = intents; return (await c.chat!.submit(O, { messageId, text })).outcomes as any[]; };
    const said = (out: any) => (out.lines as { text: string }[]).map((l) => l.text).join("\n");

    assert.ok((await call(O, "project.branches.change", { project, landing: "main" }, "lb1")).ok);
    const one = await submit("Fix the gate", "1");
    const two = await submit("Water plan", "2");
    // The owner names another landing branch: the two approved submissions stay in main's queue.
    assert.ok((await call(O, "project.branches.change", { project, landing: "trunk" }, "lb2")).ok);
    const listed = (await call(O, "landing.queue.list", { projectId: project })).result;
    assert.deepEqual([listed.branch, listed.landingBranch, listed.items, listed.others], ["trunk", "trunk", [], [{ branch: "main", entries: 2 }]]);
    const old = (await call(ivy.token, "landing.queue.list", { projectId: project, branch: "main" })).result;
    assert.deepEqual(old.items.map((e: any) => [e.position, e.submissionId]), [[1, one.id], [2, two.id]]);
    assert.equal((await call(ann.token, "landing.queue.list", { projectId: project, branch: "main" })).error?.code, "not_found");

    // Chat: the status kind is offered to the interpreter, and answers in the owner's terms.
    assert.deepEqual(STATUS_KINDS["landing_queue"]?.keys, ["projectId", "branch"]);
    await c.chat!.setFocus(O, { commandId: "f1", projectId: project });
    const q1 = "is anything still waiting to land?";
    const asked = await turn("m1", q1, [{ kind: "status", request: { kind: "landing_queue" }, evidence: q1, basis: "owner" }]);
    assert.equal(asked[0].status, "answered", JSON.stringify(asked));
    assert.match(said(asked[0]), /landing queue of branch "trunk" \(the project's landing branch\) is empty/);
    assert.match(said(asked[0]), /Branch "main" also has 2 submission\(s\) waiting in its own queue; it is not the landing branch, so they do not land now/);
    const q2 = "show me what is queued on main";
    const shown = await turn("m2", q2, [{ kind: "status", request: { kind: "landing_queue", branch: "main" }, evidence: q2, basis: "owner" }]);
    assert.equal(shown[0].status, "answered", JSON.stringify(shown));
    assert.match(said(shown[0]), /branch "main" \(not the landing branch, which is "trunk"; nothing here lands there\) holds 2 approved submission\(s\)/);
    assert.match(said(shown[0]), new RegExp(`1\\. Task ${one.task}: submission ${one.id}`));
    assert.doesNotMatch(said(shown[0]), /Branch "trunk"/, "trunk's empty queue is not named");
    // Another agent reading by the state API's status door with no right is answered nothing.
    assert.equal((await call(ann.token, "status.ask", { request: { kind: "landing_queue", projectId: project } })).error?.code, "not_found");

    // Taking work out of main's queue in plain words: the branch is the owner's own word; shown first, applied on the owner's yes.
    assert.ok(acceptedArgs("landing.queue.remove")!.includes("branch"));
    const text = "take Fix the gate out of the old main queue, it will be approved again for trunk";
    const proposed = await turn("m3", text, [{ kind: "command", op: "landing.queue.remove", args: { taskId: one.task, reason: "it will be approved again for trunk", branch: "main" }, evidence: text, basis: "owner" }]);
    assert.equal(proposed[0].status, "proposed", JSON.stringify(proposed));
    assert.equal((await call(O, "landing.queue.list", { projectId: project, branch: "main" })).result.items.length, 2, "nothing happens until the owner agrees");
    const applied = await turn("m4", "yes, go ahead", [{ kind: "apply_proposal", proposalId: proposed[0].proposalId, evidence: "yes, go ahead", basis: "owner" }]);
    assert.equal(applied[0].status, "applied", JSON.stringify(applied));
    assert.deepEqual((await call(O, "landing.queue.list", { projectId: project, branch: "main" })).result.items.map((e: any) => e.submissionId), [two.id]);
    // A branch the owner did not say is not taken from the interpreter.
    const loose = "drop the water plan from the queue";
    const refused = await turn("m5", loose, [{ kind: "command", op: "landing.queue.remove", args: { taskId: two.task, reason: "drop the water plan", branch: "main" }, evidence: loose, basis: "owner" }]);
    assert.deepEqual([refused[0].status, refused[0].code], ["refused", "unsupported_value"], JSON.stringify(refused));
    assert.match(refused[0].message, /"branch\\?" is not in your message/);
    assert.equal((await call(O, "landing.queue.list", { projectId: project, branch: "main" })).result.items.length, 1);
  } finally { await c.close(); rmSync(d, { recursive: true, force: true }); }
});
