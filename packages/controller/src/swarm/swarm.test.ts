import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { startController } from "../api/index.js";
import { BudgetService } from "../budgets/budgets.js";
import { DomainError } from "../domain/errors.js";
import type { EnvironmentFacts, FilesystemDetector } from "../environment/index.js";
import { StopService, type StopPorts } from "../lifecycle/stop.js";
import { SwarmService } from "./index.js";

const ext4: FilesystemDetector = async () => ({ type: "ext4", network: false });
const supported: EnvironmentFacts = { platform: "linux", arch: "x64", osRelease: "6.8.0-generic", nodeVersion: "22.19.0" };
const ports = (stopped: string[]): StopPorts => ({
  inventory: async () => [],
  cleanup: async () => ({ remaining: [] }),
  checkpoint: async () => ({ checkpointId: "ck", durable: true, artifactsDurable: true }),
  terminate: async (scope) => { stopped.push(scope.id); return { ended: true, unresolved: [] }; },
});

test("a child task is made with its parent's outcome and criteria and an allowance taken from the parent, refused when the parent has nothing to give or is at its limits, and cancelling the parent stops every descendant and takes back what they did not use (card H10)", async () => {
  const d = mkdtempSync(join(tmpdir(), "nn-swarm-"));
  const c = await startController({ storage: { kind: "sqlite", path: join(d, "c.sqlite") }, argv: [], env: {}, print: () => undefined, facts: supported, filesystem: ext4 });
  try {
    const boot = await c.services.principals.bootstrapOwner({ name: "rob" });
    const rob = await c.services.principals.authenticate(boot.token);
    const project = (await c.services.projects.createProject({ commandId: "p1", actor: rob.id, name: "Garden" })).id;
    const root = (await c.services.projects.createTask({ commandId: "t-root", actor: rob.id, projectId: project, title: "Plant the garden" })).id;
    const budgets = BudgetService.withEpoch(c.storage, c.epoch);
    await budgets.open(rob, { commandId: "b-open", taskId: root, currency: "USD", costMicros: 1_000_000, computeMs: 60_000 });
    const stopped: string[] = [];
    const stops = StopService.withEpoch(c.storage, c.epoch, c.services.pauses, ports(stopped));
    const swarm = SwarmService.withEpoch(c.storage, c.epoch, { projects: c.services.projects, contracts: c.services.contracts, budgets, stops, limits: { depth: 2, children: 2 } });

    const a = await swarm.spawn(rob, { commandId: "s1", parentTaskId: root, title: "Dig the bed", expectedResult: "a dug bed", acceptanceCriteria: ["30 cm deep"], costMicros: 300_000, computeMs: 10_000 });
    const contract = await c.services.contracts.get(rob, a.taskId);
    assert.deepEqual([contract?.expectedResult, contract?.acceptanceCriteria], ["a dug bed", ["30 cm deep"]]);
    assert.equal((await budgets.report(rob, root))!.delegatedToChildren.costMicros, 300_000, "the allowance left the parent");
    assert.equal((await swarm.spawn(rob, { commandId: "s1", parentTaskId: root, title: "Dig the bed", costMicros: 300_000, computeMs: 10_000 })).replayed, true, "the same command again spawns nothing more");
    assert.equal((await swarm.children(root, project)).length, 1);

    // A grandchild is the second level; a third is over the depth limit.
    const b = await swarm.spawn(rob, { commandId: "s2", parentTaskId: a.taskId, title: "Fetch the spade", costMicros: 100_000, computeMs: 1_000 });
    await assert.rejects(swarm.spawn(rob, { commandId: "s3", parentTaskId: b.taskId, title: "Too deep", costMicros: 1, computeMs: 1 }), (e: unknown) => e instanceof DomainError && /levels deep/.test(e.message));
    // A second child fills the parent's live children; a third is refused and leaves no task behind.
    await swarm.spawn(rob, { commandId: "s4", parentTaskId: root, title: "Water it", costMicros: 100_000, computeMs: 1_000 });
    const before = (await c.storage.listAggregates("task", { limit: 100 })).length;
    await assert.rejects(swarm.spawn(rob, { commandId: "s5", parentTaskId: root, title: "One too many", costMicros: 1, computeMs: 1 }), (e: unknown) => e instanceof DomainError && /live children/.test(e.message));
    // A parent with nothing left to give is refused, and the child it made is cancelled, not left without an allowance.
    await assert.rejects(swarm.spawn(rob, { commandId: "s6", parentTaskId: a.taskId, title: "Needs money", costMicros: 5_000_000, computeMs: 1 }), (e: unknown) => e instanceof DomainError);
    const tasks = await c.storage.listAggregates("task", { limit: 100 });
    assert.ok(tasks.length > before, "a refused spawn that had to make its child leaves it cancelled, not live");
    assert.ok(!tasks.some((t) => (t.body as { title?: string }).title === "Needs money" && (t.body as { state?: string }).state !== "cancelled"), "no live child without an allowance");
    // Someone without the parent's budget cannot spawn from it.
    await c.services.principals.enroll(rob, { commandId: "e1", kind: "agent", name: "eve", grants: [{ action: "task.create", project }] });
    const eve = await c.services.principals.authenticate((await c.services.principals.issueCredential(rob, "agent:eve")).token);
    const tasksBefore = (await c.storage.listAggregates("task", { limit: 200 })).length;
    await assert.rejects(swarm.spawn(eve, { commandId: "s7", parentTaskId: root, title: "Sneaky", costMicros: 1, computeMs: 1 }), (e: unknown) => e instanceof DomainError && e.code === "forbidden");
    // Not even a limit is told to someone who may not spawn (the root has two live children), and nothing is made.
    await assert.rejects(swarm.spawn(eve, { commandId: "s8", parentTaskId: root, title: "Sneaky 2", costMicros: 1, computeMs: 1 }), (e: unknown) => e instanceof DomainError && e.code === "forbidden");
    assert.equal((await c.storage.listAggregates("task", { limit: 200 })).length, tasksBefore, "no task was made for them, not even a cancelled one");
    await assert.rejects(swarm.cancel(eve, { commandId: "x0", parentTaskId: root, reason: "mischief" }), (e: unknown) => e instanceof DomainError && e.code === "forbidden");
    // A refused spawn is not completed by asking again with the same command ID after room was made.
    await assert.rejects(swarm.spawn(rob, { commandId: "s5", parentTaskId: root, title: "One too many", costMicros: 1, computeMs: 1 }), (e: unknown) => e instanceof DomainError && /new command ID|live children/.test(e.message));

    // Cancelling the parent stops the whole swarm, deepest first, and gives the allowance back.
    const result = await swarm.cancel(rob, { commandId: "x1", parentTaskId: root, reason: "plans changed" });
    assert.deepEqual(result.pending, []);
    assert.equal(result.settled[0], b.taskId, "the deepest first");
    assert.ok(result.settled.includes(a.taskId));
    assert.deepEqual(stopped.slice(0, 2), [b.taskId, a.taskId]);
    for (const id of result.settled) assert.equal((await c.services.projects.getTask(id))!.state, "cancelled");
    assert.equal((await budgets.report(rob, root))!.delegatedToChildren.costMicros, 0, "everything unused came back");
    assert.deepEqual(await swarm.cancel(rob, { commandId: "x2", parentTaskId: root, reason: "again" }), { settled: result.settled, pending: [] }, "repeating is safe");
  } finally { await c.close(); rmSync(d, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }); }
});

test("the owner spawns and cancels a swarm through the state API, and an agent without the parent's budget cannot (card H10)", async () => {
  const d = mkdtempSync(join(tmpdir(), "nn-swarm-api-"));
  const c = await startController({ storage: { kind: "sqlite", path: join(d, "c.sqlite") }, argv: [], env: {}, print: () => undefined, facts: supported, filesystem: ext4 });
  try {
    const boot = await c.services.principals.bootstrapOwner({ name: "rob" });
    const rob = await c.services.principals.authenticate(boot.token);
    const project = (await c.services.projects.createProject({ commandId: "p1", actor: rob.id, name: "Garden" })).id;
    const root = (await c.services.projects.createTask({ commandId: "t-root", actor: rob.id, projectId: project, title: "Plant" })).id;
    await BudgetService.withEpoch(c.storage, c.epoch).open(rob, { commandId: "b-open", taskId: root, currency: "USD", costMicros: 500_000, computeMs: 10_000 });
    const call = (token: string, op: string, args: Record<string, unknown>, commandId?: string) => c.api.handle(token, { v: 1, op, ...(commandId === undefined ? {} : { commandId }), args } as never) as Promise<any>;
    const made = await call(boot.token, "swarm.spawn", { parentTaskId: root, title: "Dig", acceptanceCriteria: ["deep"], costMicros: 100_000, computeMs: 1000 }, "sp1");
    assert.equal(made.ok, true, JSON.stringify(made));
    await c.services.principals.enroll(rob, { commandId: "e1", kind: "agent", name: "eve", grants: [{ action: "task.create", project }] });
    const eve = (await c.services.principals.issueCredential(rob, "agent:eve")).token;
    assert.equal((await call(eve, "swarm.spawn", { parentTaskId: root, title: "Sneaky", costMicros: 1, computeMs: 1 }, "sp2")).ok, false);
    const cancelled = await call(boot.token, "swarm.cancel", { parentTaskId: root, reason: "done with it" }, "sc1");
    assert.equal(cancelled.ok, true, JSON.stringify(cancelled));
    assert.deepEqual([cancelled.result.settled, cancelled.result.pending], [[made.result.taskId], []]);
  } finally { await c.close(); rmSync(d, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }); }
});
