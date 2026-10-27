import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { BudgetService } from "../budgets/index.js";
import type { EnvironmentFacts, FilesystemDetector } from "../environment/index.js";
import { startController } from "./index.js";

const ext4: FilesystemDetector = async () => ({ type: "ext4", network: false });
const supported: EnvironmentFacts = { platform: "linux", arch: "x64", osRelease: "6.8.0-generic", nodeVersion: "22.19.0" };

test("a request for more budget tells the owner once, budgets are read, asked for and decided through the state API with rights, and a request addressed to a holder is not the owner's to be told (card R05c)", async () => {
  const d = mkdtempSync(join(tmpdir(), "nn-budget-"));
  const c = await startController({ storage: { kind: "sqlite", path: join(d, "c.sqlite") }, argv: [], env: {}, print: () => undefined, facts: supported, filesystem: ext4 });
  try {
    const boot = await c.services.principals.bootstrapOwner({ name: "rob" });
    const rob = await c.services.principals.authenticate(boot.token);
    const project = (await c.services.projects.createProject({ commandId: "p1", actor: rob.id, name: "Garden" })).id;
    const mk = async (n: string, title: string) => (await c.services.projects.createTask({ commandId: `t-${n}`, actor: rob.id, projectId: project, title })).id;
    const root = await mk("root", "Plant the garden"); const child = await mk("child", "Dig the bed");
    const tok = async (name: string, grants: { action: string; project: string }[]) => { await c.services.principals.enroll(rob, { commandId: `e-${name}`, kind: "agent", name, grants }); return (await c.services.principals.issueCredential(rob, `agent:${name}`)).token; };
    const ann = await tok("ann", [{ action: "attempt.work", project }, { action: "budget.manage", project }]);
    const bob = await tok("bob", []);
    const budgets = BudgetService.withEpoch(c.storage, c.epoch);
    await budgets.open(rob, { commandId: "b-open", taskId: root, currency: "USD", costMicros: 1_000_000, computeMs: 60_000 });
    await budgets.delegate(rob, { commandId: "b-del", parentTaskId: root, childTaskId: child, costMicros: 200_000, computeMs: 10_000, holder: "agent:ann" });
    const call = (token: string, op: string, args: Record<string, unknown>, commandId?: string) => c.api.handle(token, { v: 1, op, ...(commandId === undefined ? {} : { commandId }), args } as never) as Promise<{ ok: boolean; result?: any; error?: { code: string } }>;
    const budgetNotices = async () => (await c.storage.listAggregates("notification-item", { limit: 50 })).filter((n) => JSON.stringify(n.body).includes("budget-request")).length;

    // The task with a root allowance asks the owner: the owner is told once, and sees the request.
    const asked = await call(ann, "budget.request-more", { taskId: root, costMicros: 500_000, reason: "more seeds" }, "bq1");
    assert.ok(asked.ok, JSON.stringify(asked));
    assert.equal(asked.result.to, "owner");
    assert.equal(await budgetNotices(), 1);
    assert.equal((await call(ann, "budget.request-more", { taskId: root, costMicros: 500_000, reason: "more seeds" }, "bq1")).result.replayed, true);
    assert.equal(await budgetNotices(), 1, "repeating the command tells nothing more");
    const pending = await call(boot.token, "budget.pending", {});
    assert.deepEqual(pending.result.requests.map((r: { id: string }) => r.id), [asked.result.id]);
    // Rights: the requester and the owner may read it; a stranger sees nothing; only the addressee may decide.
    assert.ok((await call(ann, "budget.get-request", { requestId: asked.result.id })).ok);
    assert.equal((await call(bob, "budget.get-request", { requestId: asked.result.id })).error?.code, "not_found");
    assert.equal((await call(ann, "budget.decide", { requestId: asked.result.id, approve: true }, "bd0")).error?.code, "forbidden", "a request addressed to the owner is the owner's to decide");
    assert.equal((await call(bob, "budget.report", { taskId: root })).error?.code, "not_found");
    const before = (await call(boot.token, "budget.report", { taskId: root })).result.item;
    assert.ok(before.limit !== undefined && before.uncertain !== undefined && before.reservedInFlight !== undefined, "outstanding and uncertain charges are in the report");
    // The owner grants less than asked.
    assert.ok((await call(boot.token, "budget.decide", { requestId: asked.result.id, approve: true, costMicros: 300_000 }, "bd1")).ok);
    const after = (await call(boot.token, "budget.report", { taskId: root })).result.item;
    assert.equal(after.limit.costMicros - before.limit.costMicros, 300_000);
    assert.equal((await call(boot.token, "budget.pending", {})).result.requests.length, 0);
    assert.ok((await call(boot.token, "budget.usage", { projectId: project })).ok);
    assert.equal((await call(boot.token, "budget.usage", { category: "nonsense" })).error?.code, "invalid_command");

    // A task whose parent has a holder asks the holder: the owner is not told, and the holder finds it among its pending requests.
    const grandchild = await mk("grand", "Water the bed");
    await budgets.delegate(rob, { commandId: "b-del2", parentTaskId: child, childTaskId: grandchild, costMicros: 50_000, computeMs: 1_000 });
    const sub = await call(ann, "budget.request-more", { taskId: grandchild, costMicros: 10_000, reason: "more water" }, "bq2");
    assert.ok(sub.ok, JSON.stringify(sub));
    assert.equal(sub.result.to, "agent:ann");
    assert.equal(await budgetNotices(), 1, "the owner is not told of a request addressed to a holder");
    assert.deepEqual((await call(ann, "budget.pending", {})).result.requests.map((r: { id: string }) => r.id), [sub.result.id]);
    // The holder decides within what it holds.
    assert.ok((await call(ann, "budget.decide", { requestId: sub.result.id, approve: true, costMicros: 5_000 }, "bd2")).ok);
    assert.equal((await call(ann, "budget.pending", {})).result.requests.length, 0);
    assert.equal((await call(ann, "budget.report", { taskId: grandchild })).result.item.limit.costMicros, 55_000);
  } finally { await c.close(); rmSync(d, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }); }
});

test("a task credential may not list, total or read budgets beyond its own task, and a request addressed to a holder is theirs to decide (card R05c)", async () => {
  const { OPERATION_BY_NAME } = await import("./operations.js");
  const ctx = (taskId: string) => ({ principal: { id: "agent:ann", kind: "agent", name: "ann", grants: [], taskScope: { taskId, projectId: "proj-aaaaaaaaaaaaaaaaaaaa" } }, budgets: { pending: async () => ({ requests: [{ taskId: "task-bbbbbbbbbbbbbbbbbbbb" }], truncated: false }), usage: async () => ({}), request: async () => ({ taskId: "task-bbbbbbbbbbbbbbbbbbbb" }) } } as never);
  const run = (op: string, args: Record<string, unknown>, taskId = "task-aaaaaaaaaaaaaaaaaaaa") => OPERATION_BY_NAME.get(op)!.run(ctx(taskId), args, undefined);
  await assert.rejects(() => run("budget.pending", {}), (e: { code?: string }) => e.code === "forbidden");
  await assert.rejects(() => run("budget.usage", { projectId: "proj-aaaaaaaaaaaaaaaaaaaa" }), (e: { code?: string }) => e.code === "forbidden");
  await assert.rejects(() => run("budget.get-request", { requestId: "bgq-aaaaaaaaaaaaaaaaaaaa" }), (e: { code?: string }) => e.code === "not_found", "another task's request reads as missing");
  assert.ok(await run("budget.get-request", { requestId: "bgq-aaaaaaaaaaaaaaaaaaaa" }, "task-bbbbbbbbbbbbbbbbbbbb"), "its own task's request is readable");
});
