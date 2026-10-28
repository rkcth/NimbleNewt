import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { BudgetService } from "../budgets/index.js";
import { ManualTimer } from "../dispatch/testing/timer.js";
import { PI } from "../dispatch/testing/world.js";
import type { EnvironmentFacts, FilesystemDetector } from "../environment/index.js";
import { startController } from "./index.js";

const ext4: FilesystemDetector = async () => ({ type: "ext4", network: false });
const supported: EnvironmentFacts = { platform: "linux", arch: "x64", osRelease: "6.8.0-generic", nodeVersion: "22.19.0" };

test("a background job that ends is charged to its task as background-job use, once, and shows in budget.usage through the state API (card R05f)", async () => {
  const d = mkdtempSync(join(tmpdir(), "nn-usage-"));
  const problems: unknown[] = [];
  const c = await startController({
    storage: { kind: "sqlite", path: join(d, "c.sqlite") }, argv: [], env: {}, print: () => undefined, facts: supported, filesystem: ext4, features: [], harnesses: [PI],
    dispatch: { timer: new ManualTimer(), intervalMs: 1000 }, onInternalError: (e) => { problems.push(e); },
  });
  try {
    const boot = await c.services.principals.bootstrapOwner({ name: "rob" });
    const rob = await c.services.principals.authenticate(boot.token);
    const project = (await c.services.projects.createProject({ commandId: "p1", actor: rob.id, name: "Garden" })).id;
    const task = (await c.services.projects.createTask({ commandId: "t1", actor: rob.id, projectId: project, title: "Build" })).id;
    await c.services.principals.enroll(rob, { commandId: "e-ann", kind: "agent", name: "ann", grants: [{ action: "job.write", project }] });
    const ann = await c.services.principals.authenticate((await c.services.principals.issueCredential(rob, "agent:ann")).token);
    await BudgetService.withEpoch(c.storage, c.epoch).open(rob, { commandId: "b-open", taskId: task, currency: "USD", costMicros: 1_000_000, computeMs: 600_000 });
    const jobId = (await c.services.jobs.admit(ann, { commandId: "ja", taskId: task, kind: "tool", label: "build", operationId: "op-1", background: true })).id;
    await c.services.jobs.report(ann, { commandId: "jr1", jobId, state: "dispatched", host: "host-1" });
    await c.services.jobs.report(ann, { commandId: "jr2", jobId, state: "running" });
    await new Promise((r) => setTimeout(r, 25));
    await c.services.jobs.finish(ann, { commandId: "jf", jobId, outcome: "completed", exit: { code: 0 } });
    await c.services.jobs.finish(ann, { commandId: "jf", jobId, outcome: "completed", exit: { code: 0 } });
    const usage = await c.api.handle(boot.token, { v: 1, op: "budget.usage", args: { projectId: project } } as never) as { ok: boolean; result: any };
    assert.ok(usage.ok, JSON.stringify(usage));
    const text = JSON.stringify(usage.result);
    assert.match(text, /background-job/, "the job's time is in the usage by activity");
    const entries = (await c.storage.listAggregates("budget-entry", { limit: 50 })).map((e) => e.body as unknown as { activity: string; taskId?: string; computeMs: number });
    const mine = entries.filter((e) => e.activity === "background-job");
    assert.equal(mine.length, 1, "ending twice charges once");
    assert.equal(mine[0]!.taskId, task);
    assert.ok(mine[0]!.computeMs >= 20, `the time it ran is charged (${mine[0]!.computeMs} ms)`);
    assert.deepEqual(problems, []);
  } finally { await c.close(); rmSync(d, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }); }
});

test("an agent reviewer's allow is charged to the task reviewed as review use, with the reviewer, and shows in budget.usage through the state API (card R05f)", async () => {
  const d = mkdtempSync(join(tmpdir(), "nn-usage-"));
  const problems: unknown[] = [];
  const c = await startController({
    storage: { kind: "sqlite", path: join(d, "c.sqlite") }, argv: [], env: {}, print: () => undefined, facts: supported, filesystem: ext4, features: [], harnesses: [PI],
    dispatch: { timer: new ManualTimer(), intervalMs: 1000 }, onInternalError: (e) => { problems.push(e); },
  });
  try {
    const boot = await c.services.principals.bootstrapOwner({ name: "rob" });
    const rob = await c.services.principals.authenticate(boot.token);
    const project = (await c.services.projects.createProject({ commandId: "p1", actor: rob.id, name: "Garden" })).id;
    const task = (await c.services.projects.createTask({ commandId: "t1", actor: rob.id, projectId: project, title: "Build" })).id;
    const agent = async (name: string, grants: { action: string; project: string }[]) => { await c.services.principals.enroll(rob, { commandId: `e-${name}`, kind: "agent", name, grants }); return c.services.principals.authenticate((await c.services.principals.issueCredential(rob, `agent:${name}`)).token); };
    const ann = await agent("ann", [{ action: "review.request", project }, { action: "attempt.work", project }, { action: "tool.run-script", project }]);
    const r1 = await agent("r1", [{ action: "review.decide", project }, { action: "attempt.work", project }]);
    await BudgetService.withEpoch(c.storage, c.epoch).open(rob, { commandId: "b-open", taskId: task, currency: "USD", costMicros: 1_000_000, computeMs: 600_000 });
    await c.services.reviews.setPolicy(rob, { commandId: "pol", projectId: project, policy: { reviewers: ["agent:r1"] } });
    const asked = await c.services.reviews.request(ann, { commandId: "rq", taskId: task, operation: { name: "run-script", args: { cwd: "/work" }, script: "echo hi\n", target: { kind: "workspace", id: "main" } }, context: { toolVersion: "1.2.3", authoritySource: "task grant", expectedEffects: ["prints"] } });
    await new Promise((r) => setTimeout(r, 30));
    const v = (await c.services.reviews.get(rob, asked.id))!;
    await c.services.reviews.decide(r1, { commandId: "dc", requestId: asked.id, expectedRevision: v.revision, verdict: "allow", reason: "looks fine" });
    const entries = (await c.storage.listAggregates("budget-entry", { limit: 50 })).map((e) => e.body as unknown as { activity: string; taskId?: string; agentId?: string; computeMs: number });
    const mine = entries.filter((e) => e.activity === "review");
    assert.equal(mine.length, 1);
    assert.deepEqual([mine[0]!.taskId, mine[0]!.agentId], [task, "agent:r1"]);
    assert.ok(mine[0]!.computeMs >= 25, `the time from assignment to decision is charged (${mine[0]!.computeMs} ms)`);
    const usage = await c.api.handle(boot.token, { v: 1, op: "budget.usage", args: { projectId: project } } as never) as { ok: boolean; result: unknown };
    assert.ok(usage.ok);
    assert.match(JSON.stringify(usage.result), /review/);
    assert.deepEqual(problems, []);
  } finally { await c.close(); rmSync(d, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }); }
});

test("the time an agent spends in a held meeting is charged to its meeting task once and shows in budget.usage through the state API (card R05g)", async () => {
  const d = mkdtempSync(join(tmpdir(), "nn-usage-"));
  const problems: unknown[] = [];
  let now = Date.now();
  const c = await startController({
    storage: { kind: "sqlite", path: join(d, "c.sqlite") }, argv: [], env: {}, print: () => undefined, facts: supported, filesystem: ext4, features: [], harnesses: [PI],
    dispatch: { timer: new ManualTimer(), intervalMs: 1000, clock: () => new Date(now).toISOString() }, onInternalError: (e) => { problems.push(e); },
  });
  try {
    const boot = await c.services.principals.bootstrapOwner({ name: "rob" });
    const rob = await c.services.principals.authenticate(boot.token);
    const project = (await c.services.projects.createProject({ commandId: "p1", actor: rob.id, name: "Garden" })).id;
    const who = async (name: string): Promise<string> => {
      const id = (await c.services.agents.create(rob, { commandId: `ag-${name}`, friendlyName: name })).id;
      const principalId = `agent:${id}`;
      const found = await c.storage.getAggregate({ kind: "principal", id: principalId });
      await c.services.principals.setGrants(rob, { commandId: `sg-${name}`, principalId, expectedRevision: found!.revision, grants: [{ action: "history.*", project }, { action: "task.read", project }] });
      return principalId;
    };
    const [annId, bobId] = [await who("ann"), await who("bob")];
    const ann = await c.services.principals.authenticate((await c.services.principals.issueCredential(rob, annId)).token);
    const project0 = await c.storage.getAggregate({ kind: "project", id: project });
    await c.services.plans.setPlan(rob, { commandId: "plan1", projectId: project, expectedRevision: project0!.revision, participants: [{ principalId: annId }, { principalId: bobId }] } as never);
    const urgent = await c.api.handle(boot.token, { v: 1, op: "meeting.call-urgent", commandId: "mu1", args: { projectId: project, title: "Hotfix", reason: "prod is down", roster: [annId, bobId] } } as never) as unknown as { ok: boolean; result: { id: string } };
    assert.ok(urgent.ok, JSON.stringify(urgent));
    const attendance = c.dispatch!.attendance;
    await attendance.openRoom(rob, { commandId: "or1", occurrenceId: urgent.result.id } as never);
    await attendance.prepare(rob, { commandId: "pp1", occurrenceId: urgent.result.id, agent: annId, interrupted: [] });
    const joined = await attendance.join(ann, { commandId: "jn1", occurrenceId: urgent.result.id, agent: annId });
    assert.ok(joined.joined, JSON.stringify(joined));
    now += 7 * 60_000;
    await attendance.leave(ann, { commandId: "lv1", occurrenceId: urgent.result.id, agent: annId });
    await attendance.leave(ann, { commandId: "lv1", occurrenceId: urgent.result.id, agent: annId });
    const entries = (await c.storage.listAggregates("budget-entry", { limit: 50 })).map((e) => e.body as unknown as { activity: string; taskId?: string; agentId?: string; computeMs: number });
    const mine = entries.filter((e) => e.activity === "meeting");
    assert.equal(mine.length, 1, "leaving twice charges once");
    assert.deepEqual([mine[0]!.agentId, mine[0]!.taskId, mine[0]!.computeMs], [annId, joined.meetingTaskId, 7 * 60_000]);
    const usage = await c.api.handle(boot.token, { v: 1, op: "budget.usage", args: { projectId: project } } as never) as { ok: boolean; result: unknown };
    assert.ok(usage.ok, JSON.stringify(usage));
    assert.match(JSON.stringify(usage.result), /meeting/);
    assert.deepEqual(await c.dispatch!.unsettledCharges(rob), []);
    assert.ok((await c.dispatch!.dispatcher.tick()).loops.some((l) => l.name === "charge-retry" && l.ok), "the retry sweep runs in the dispatcher's tick");
    assert.deepEqual(problems, []);
  } finally { await c.close(); rmSync(d, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }); }
});
