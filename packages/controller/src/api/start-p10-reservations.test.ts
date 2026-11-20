import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { ScriptedInterpreter } from "../chat/index.js";
import type { EnvironmentFacts, FilesystemDetector } from "../environment/index.js";
import { PI } from "../dispatch/testing/world.js";
import { NotificationService } from "../notifications/index.js";
import { startController } from "./index.js";

const ext4: FilesystemDetector = async () => ({ type: "ext4", network: false });
const supported: EnvironmentFacts = { platform: "linux", arch: "x64", osRelease: "6.8.0-generic", nodeVersion: "22.19.0" };
const base = "a".repeat(40), tree = "b".repeat(40), patch = "c".repeat(40);

// Card P10, reservations, through the composed controller: the project's refresh-round cap (`integration.refreshRounds`) reserves a task's place; a reserved task that needs another round is told to the project's
// director (a notice in its inbox) and to the owner; the director may end the reservation; the owner sees the reservation in chat and ends one in plain words (shown first). Without a director the owner is told
// as needs-you.
test("a reservation at the refresh-round cap, its escalation to the director and the owner, and ending it by the director or by chat (card P10, reservations)", async () => {
  const d = mkdtempSync(join(tmpdir(), "nn-p10r-"));
  const say: Record<string, unknown[]> = {};
  const c = await startController({ storage: { kind: "sqlite", path: join(d, "c.sqlite") }, argv: [], env: {}, print: () => undefined, facts: supported, filesystem: ext4, features: [], harnesses: [PI], chat: { interpreter: new ScriptedInterpreter((input) => say[input.text] ?? []) } } as never);
  try {
    const s = c.services;
    const boot = await s.principals.bootstrapOwner({ name: "rob" });
    const rob = await s.principals.authenticate(boot.token);
    const O = boot.token;
    const call = (token: string, op: string, args: Record<string, unknown>, commandId?: string) => c.api.handle(token, { v: 1, op, ...(commandId === undefined ? {} : { commandId }), args } as never) as Promise<any>;
    const project = (await s.projects.createProject({ commandId: "p1", actor: rob.id, name: "Garden" })).id;
    const other = (await s.projects.createProject({ commandId: "p2", actor: rob.id, name: "Orchard" })).id;
    const hire = async (name: string, roles: string[], where: string, more: string[] = []) => {
      const made = await s.agents.create(rob, { commandId: `mk-${name}`, friendlyName: name, roles });
      const id = `agent:${made.id}`;
      for (const [i, action] of ["task.read", "message.receive", ...more].entries()) await s.grants.grant(rob, { commandId: `g-${name}-${i}`, grantee: id, action, project: where, source: "direct", basis: "test" } as never);
      return { id, token: (await s.principals.issueCredential(rob, id)).token };
    };
    const ann = await hire("Ann", ["author"], project);
    const rev = await hire("Rev", ["reviewer"], project);
    const dee = await hire("Dee", ["director"], project);
    const odo = await hire("Odo", ["director"], other);
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
    const directorNotices = async (who: string) => {
      const inbox = (await c.storage.getAggregate({ kind: "agent-inbox", id: who }))?.body as { pending?: { id: string; sender: string }[] } | undefined;
      const out: { purpose: string; text: string; taskId: string }[] = [];
      for (const p of inbox?.pending ?? []) { const m = (await c.storage.getAggregate({ kind: "agent-message", id: p.id }))?.body as { purpose: string; text: string; taskId: string; kind: string } | undefined; if (m?.kind === "notice") out.push(m); }
      return out;
    };
    const ownerTold = async (taskId: string) => (await NotificationService.withEpoch(c.storage, c.epoch).inbox(rob)).items.filter((i) => i.ref.kind === "task" && i.ref.id === taskId);

    assert.ok((await call(O, "project.branches.change", { project, landing: "main" }, "lb1")).ok);
    assert.ok((await call(O, "integration.set", { project, refreshRounds: 1 }, "is1")).ok);
    const one = await submit("Fix the gate", "1");
    const two = await submit("Water plan", "2");
    const q = s.landingQueue;
    // The project's cap is 1: the first round reserves the task's place.
    assert.equal(await q.afterRound({ taskId: two.task, projectId: project, round: 1 }), "reserved");
    const listed = (await call(O, "landing.queue.list", { projectId: project })).result;
    assert.deepEqual(listed.reservations.map((r: any) => [r.taskId, r.round, r.cap]), [[two.task, 1, 1]]);
    // Another round although the place is reserved: the director of this project is told in its inbox (not another project's director), and the owner gets a notice saying so.
    assert.equal(await q.afterRound({ taskId: two.task, projectId: project, round: 2 }), "escalated");
    const notices = await directorNotices(dee.id);
    assert.equal(notices.length, 1, JSON.stringify(notices));
    assert.equal(notices[0]!.taskId, two.task);
    assert.match(notices[0]!.text, /needed refresh round 2 although its place in the landing queue of branch main was reserved at round 1 \(the cap is 1\)/);
    const told = await ownerTold(two.task);
    assert.equal(told.length, 1, JSON.stringify(told));
    assert.equal(told[0]!.level, "notice");
    assert.match(told[0]!.detail ?? "", /Landing queue of main waits on task .*stale again after its reserved place.*The director was told/);
    // The director ends the reservation through the state API; an agent that is neither the owner, an integrator, a director nor the entry's author cannot.
    assert.equal((await call(rev.token, "landing.queue.remove", { taskId: two.task, reason: "not mine" }, "x1")).error?.code, "not_found");
    const ended = await call(dee.token, "landing.queue.remove", { taskId: two.task, reason: "it waits for the redesign" }, "x2");
    assert.deepEqual([ended.ok, ended.result.reservationEnded, ended.result.removed?.taskId], [true, true, two.task], JSON.stringify(ended));
    assert.deepEqual((await call(O, "landing.queue.list", { projectId: project })).result.reservations, []);

    // Chat: the owner sees a reservation in the landing_queue view, and ends one in plain words (shown first, applied on the yes).
    assert.equal(await q.afterRound({ taskId: one.task, projectId: project, round: 1 }), "reserved");
    await c.chat!.setFocus(O, { commandId: "f1", projectId: project });
    const q1 = "why is nothing else landing?";
    const asked = await turn("m1", q1, [{ kind: "status", request: { kind: "landing_queue" }, evidence: q1, basis: "owner" }]);
    assert.equal(asked[0].status, "answered", JSON.stringify(asked));
    assert.match(said(asked[0]), new RegExp(`1\\. Task ${one.task}: submission ${one.id} .*; its place is reserved\\.`));
    assert.match(said(asked[0]), new RegExp(`Task ${one.task} has a reserved place since .*: its author reached the refresh-round cap \\(round 1, cap 1\\), so it keeps its turn\\. Taking the task out of the queue ends the reservation\\.`));
    const text = "stop holding the branch for Fix the gate, let the others land";
    const proposed = await turn("m2", text, [{ kind: "command", op: "landing.queue.remove", args: { taskId: one.task, reason: "let the others land" }, evidence: text, basis: "owner" }]);
    assert.equal(proposed[0].status, "proposed", JSON.stringify(proposed));
    assert.equal((await call(O, "landing.queue.list", { projectId: project })).result.reservations.length, 1, "nothing happens until the owner agrees");
    const applied = await turn("m3", "yes, go ahead", [{ kind: "apply_proposal", proposalId: proposed[0].proposalId, evidence: "yes, go ahead", basis: "owner" }]);
    assert.equal(applied[0].status, "applied", JSON.stringify(applied));
    const after = (await call(O, "landing.queue.list", { projectId: project })).result;
    assert.deepEqual([after.reservations, after.items.map((e: any) => e.taskId)], [[], []]);

    // A project with no director that can be told: the owner is told as needs-you (another project's director does not count, and is not told). The default cap is 3.
    const third = (await s.projects.createProject({ commandId: "p3", actor: rob.id, name: "Meadow" })).id;
    assert.ok((await call(O, "project.branches.change", { project: third, landing: "main" }, "lb3")).ok);
    const four = { task: (await s.projects.createTask({ commandId: "t-4", actor: rob.id, projectId: third, title: "Mow" })).id };
    // Meadow has a director that cannot read its tasks (a grant naming the project, but not task.read): it cannot be told, so that does not count as telling the director.
    const mo = await s.agents.create(rob, { commandId: "mk-Mo", friendlyName: "Mo", roles: ["director"] });
    await s.grants.grant(rob, { commandId: "g-Mo", grantee: `agent:${mo.id}`, action: "project.read", project: third, source: "direct", basis: "test" } as never);
    assert.equal(await q.afterRound({ taskId: four.task, projectId: third, round: 2 }), undefined);
    assert.equal(await q.afterRound({ taskId: four.task, projectId: third, round: 3 }), "reserved");
    assert.equal(await q.afterRound({ taskId: four.task, projectId: third, round: 4 }), "escalated");
    const alone = await ownerTold(four.task);
    assert.equal(alone.length, 1);
    assert.equal(alone[0]!.level, "needs-you");
    assert.match(alone[0]!.detail ?? "", /No director could be told: you decide, or take it out\./);
    assert.equal((await directorNotices(dee.id)).length, 1, "Garden's director is not told about Meadow");
    assert.equal((await directorNotices(odo.id)).length, 0, "nor is Orchard's");
    assert.equal((await directorNotices(`agent:${mo.id}`)).length, 0);
  } finally { await c.close(); rmSync(d, { recursive: true, force: true }); }
});
