import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { ScriptedInterpreter } from "../chat/index.js";
import type { EnvironmentFacts, FilesystemDetector } from "../environment/index.js";
import { PI } from "../dispatch/testing/world.js";
import { startController } from "./index.js";

const ext4: FilesystemDetector = async () => ({ type: "ext4", network: false });
const supported: EnvironmentFacts = { platform: "linux", arch: "x64", osRelease: "6.8.0-generic", nodeVersion: "22.19.0" };
const base = "a".repeat(40), tree = "b".repeat(40), patch = "c".repeat(40);

// Card P10, tenth slice review, through the composed controller: the stuck-place line of the landing_queue view is the same in chat as through the state API (`status.ask`), with the controller's own
// bounds (twelve hours for an idle reserved place); an integrator reads it, an agent without the integrator's right is told the project does not exist, and a task credential is shown nothing.
test("the owner sees in chat, as through the state API, since when a reserved first place has had no approved submission and when the controller ends it (card P10, tenth slice review)", async () => {
  const d = mkdtempSync(join(tmpdir(), "nn-p10i-"));
  const say: Record<string, unknown[]> = {};
  const c = await startController({ storage: { kind: "sqlite", path: join(d, "c.sqlite") }, argv: [], env: {}, print: () => undefined, facts: supported, filesystem: ext4, features: [], harnesses: [PI], chat: { interpreter: new ScriptedInterpreter((input) => say[input.text] ?? []) } } as never);
  try {
    const s = c.services;
    const boot = await s.principals.bootstrapOwner({ name: "rob" });
    const rob = await s.principals.authenticate(boot.token);
    const O = boot.token;
    const call = (token: string, op: string, args: Record<string, unknown>, commandId?: string) => c.api.handle(token, { v: 1, op, ...(commandId === undefined ? {} : { commandId }), args } as never) as Promise<any>;
    const project = (await s.projects.createProject({ commandId: "p1", actor: rob.id, name: "Garden" })).id;
    const hire = async (name: string, roles: string[], more: string[] = []) => {
      const made = await s.agents.create(rob, { commandId: `mk-${name}`, friendlyName: name, roles });
      const id = `agent:${made.id}`;
      for (const [i, action] of ["task.read", "message.receive", ...more].entries()) await s.grants.grant(rob, { commandId: `g-${name}-${i}`, grantee: id, action, project, source: "direct", basis: "test" } as never);
      return { id, token: (await s.principals.issueCredential(rob, id)).token };
    };
    const ann = await hire("Ann", ["author"]);
    const rev = await hire("Rev", ["reviewer"]);
    const ivy = await hire("Ivy", ["integrator"], ["integration.lease"]);
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
    assert.ok((await call(O, "project.branches.change", { project, landing: "main" }, "lb1")).ok);
    assert.ok((await call(O, "integration.set", { project, refreshRounds: 1 }, "is1")).ok);
    const one = await submit("Fix the gate", "1");
    const two = await submit("Water plan", "2");
    assert.equal(await s.landingQueue.afterRound({ taskId: one.task, projectId: project, round: 1 }), "reserved");
    // The approval of the first task's work is taken back: its reserved place stays first with no approved submission.
    { const back = await call(rev.token, "submission.record", { taskId: one.task, kind: "review", role: "reviewer", subject: one.id, verdict: "changes" }, "rev-1b"); assert.ok(back.ok, JSON.stringify(back)); }
    const listed = (await call(O, "landing.queue.list", { projectId: project })).result;
    assert.deepEqual([listed.front.taskId, listed.front.waitingForApproval, listed.front.releaseMs, listed.front.holdMs], [one.task, true, 12 * 3_600_000, 4 * 3_600_000], JSON.stringify(listed.front));
    const idle = listed.front.idleSince as string;
    assert.ok(Number.isFinite(Date.parse(idle)), idle);

    const viaApi = await call(O, "status.ask", { request: { kind: "landing_queue", projectId: project } });
    assert.equal(viaApi.ok, true, JSON.stringify(viaApi));
    const apiLines = (viaApi.result.item.lines as { text: string }[]).map((l) => l.text);
    const stuck = apiLines.filter((l) => /no approved submission since/.test(l));
    assert.equal(stuck.length, 1, apiLines.join("\n"));
    assert.match(stuck[0]!, new RegExp(`^Task ${one.task}'s reserved place has had no approved submission since ${idle.replace(/[.]/g, "\\.")}; once that has lasted 12 h \\(at ${new Date(Date.parse(idle) + 12 * 3_600_000).toISOString().replace(/[.]/g, "\\.")}\\) the controller ends the reservation by itself, checked only when a landing of a submission queued behind it is asked for`));
    assert.ok(apiLines.some((l) => l.includes(`Task ${two.task}`)), "the approved work behind it is listed");

    await c.chat!.setFocus(O, { commandId: "f1", projectId: project });
    const q1 = "why is nothing landing?";
    say[q1] = [{ kind: "status", request: { kind: "landing_queue" }, evidence: q1, basis: "owner" }];
    const asked = (await c.chat!.submit(O, { messageId: "m1", text: q1 })).outcomes as any[];
    assert.equal(asked[0].status, "answered", JSON.stringify(asked));
    assert.deepEqual((asked[0].lines as { text: string }[]).map((l) => l.text), apiLines, "chat shows what the state API shows");

    // An integrator reads the same line; an author, a task credential and the integrator's own task credential are told the project does not exist (nothing of the queue is said).
    const asIvy = await call(ivy.token, "status.ask", { request: { kind: "landing_queue", projectId: project } });
    assert.deepEqual((asIvy.result.item.lines as { text: string }[]).map((l) => l.text).filter((l) => /no approved submission since/.test(l)), stuck);
    assert.equal((await call(ann.token, "status.ask", { request: { kind: "landing_queue", projectId: project } })).error?.code, "not_found");
    const annTask = (await s.taskCredentials.issue(rob, { commandId: "tc-ann", taskId: one.task, agentId: ann.id })).token;
    // A task credential is refused status.ask as a whole (before any view is read), and the queue itself is "not found": neither says anything of the queue.
    for (const [op, args] of [["status.ask", { request: { kind: "landing_queue", projectId: project } }], ["landing.queue.list", { projectId: project }]] as const) {
      const out = await call(annTask, op, args as Record<string, unknown>);
      assert.ok(["forbidden", "not_found"].includes(out.error?.code), JSON.stringify(out));
      assert.equal(out.result, undefined);
      assert.doesNotMatch(JSON.stringify(out.error), /reserved|idle|landing queue of|main/i);
    }
  } finally { await c.close(); rmSync(d, { recursive: true, force: true }); }
});
