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
