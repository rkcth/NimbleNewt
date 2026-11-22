import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { NotificationService } from "../notifications/index.js";
import { ManualTimer } from "../dispatch/testing/timer.js";
import type { EnvironmentFacts, FilesystemDetector } from "../environment/index.js";
import { PI } from "../dispatch/testing/world.js";
import { startController } from "./index.js";

const ext4: FilesystemDetector = async () => ({ type: "ext4", network: false });
const supported: EnvironmentFacts = { platform: "linux", arch: "x64", osRelease: "6.8.0-generic", nodeVersion: "22.19.0" };
const base = "a".repeat(40), tree = "b".repeat(40), patch = "c".repeat(40);

// Card P10, eleventh slice, through the composed controller: the dispatcher's regular round (`landing.queue.bounds`) ends a reserved first place that has had no approved submission for the project's release
// bound (twelve hours) while another task's approved work waits behind it, with nobody asking to land; the owner and the director are told once; a round with nothing waiting behind a place ends nothing.
test("the controller's regular round ends a reserved place idle past twelve hours with approved work behind it, without any landing asked for (card P10, eleventh slice)", async () => {  const d = mkdtempSync(join(tmpdir(), "nn-p10i-"));
  let now = Date.now();
  const c = await startController({ storage: { kind: "sqlite", path: join(d, "c.sqlite") }, argv: [], env: {}, print: () => undefined, facts: supported, filesystem: ext4, features: [], harnesses: [PI], dispatch: { timer: new ManualTimer(), manual: true, clock: () => new Date(now).toISOString() } } as never);
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
    const hold = (await call(O, "landing.queue.list", { projectId: project })).result;
    assert.deepEqual([hold.front.taskId, hold.items.map((e: any) => e.taskId)], [one.task, [two.task]]);
    const round = async (): Promise<void> => { const t = await c.dispatch!.dispatcher.tick(); const loop = t.loops.find((x: any) => x.name === "landing.queue.bounds"); assert.ok(loop !== undefined, "the round is one of the dispatcher's loops: " + t.loops.map((x: any) => x.name).join(",")); assert.equal(loop.ok, true, JSON.stringify(t.loops.filter((x: any) => !x.ok))); };
    const told = async () => (await NotificationService.withEpoch(c.storage, c.epoch).inbox(rob)).items.filter((i) => i.ref.kind === "task" && i.ref.id === one.task && /reserved place was released/.test(i.detail ?? ""));
    // Just under the bound: nothing.
    now += 12 * 3_600_000 - 60_000;
    await round();
    assert.equal((await call(O, "landing.queue.list", { projectId: project })).result.front.taskId, one.task);
    assert.equal((await told()).length, 0);
    // At the bound the round ends the place by itself; nobody asked to land.
    now += 60_000;
    await round();
    const after = (await call(O, "landing.queue.list", { projectId: project })).result;
    assert.deepEqual([after.front.taskId, after.reservations.length, after.items.map((e: any) => e.taskId)], [two.task, 0, [two.task]], JSON.stringify(after));
    const items = await told();
    assert.equal(items.length, 1, JSON.stringify(items));
    assert.match(items[0]!.detail ?? "", /reserved place was released/);
    await round(); await round();
    assert.equal((await told()).length, 1, "later rounds tell nobody again");
    assert.equal((await call(O, "landing.queue.list", { projectId: project })).result.items.length, 1, "the approved work was not removed");
  } finally { await c.close(); rmSync(d, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }); }
});
