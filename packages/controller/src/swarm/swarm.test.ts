import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { startController } from "../api/index.js";
import { BudgetService } from "../budgets/budgets.js";
import { DomainError } from "../domain/errors.js";
import { ProjectService } from "../domain/service.js";
import { backends, stopServer } from "../domain/testing/backends.js";
import { PrincipalService } from "../security/index.js";
import { ContractService } from "../planning/index.js";
import { PauseService } from "../lifecycle/pause.js";
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

    // Someone who holds only the root's allowance cannot stop (and so half-cancel) a child under a node they do not hold.
    await c.services.principals.enroll(rob, { commandId: "e2", kind: "agent", name: "ann", grants: [{ action: "task.create", project }, { action: "budget.manage", project }, { action: "task.stop", project }, { action: "lifecycle.pause", project }] });
    // (The root and its children have no holder, so ann holds nothing: cancelling is refused before anything is stopped.)
    const ann = await c.services.principals.authenticate((await c.services.principals.issueCredential(rob, "agent:ann")).token);
    const stoppedBefore = stopped.length;
    await assert.rejects(swarm.cancel(ann, { commandId: "x3", parentTaskId: root, reason: "not mine" }), (e: unknown) => e instanceof DomainError && e.code === "forbidden");
    assert.equal(stopped.length, stoppedBefore, "nothing was stopped");

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

test("spawns sent at the same moment cannot take a parent over its live-children limit (card H10 follow-up)", async () => {
  const d = mkdtempSync(join(tmpdir(), "nn-swarm-race-"));
  const c = await startController({ storage: { kind: "sqlite", path: join(d, "c.sqlite") }, argv: [], env: {}, print: () => undefined, facts: supported, filesystem: ext4 });
  try {
    const boot = await c.services.principals.bootstrapOwner({ name: "rob" });
    const rob = await c.services.principals.authenticate(boot.token);
    const project = (await c.services.projects.createProject({ commandId: "p1", actor: rob.id, name: "Garden" })).id;
    const root = (await c.services.projects.createTask({ commandId: "t-root", actor: rob.id, projectId: project, title: "Plant" })).id;
    const budgets = BudgetService.withEpoch(c.storage, c.epoch);
    await budgets.open(rob, { commandId: "b-open", taskId: root, currency: "USD", costMicros: 1_000_000, computeMs: 60_000 });
    const swarm = SwarmService.withEpoch(c.storage, c.epoch, { projects: c.services.projects, contracts: c.services.contracts, budgets, stops: StopService.withEpoch(c.storage, c.epoch, c.services.pauses, ports([])), limits: { depth: 2, children: 3 } });
    const results = await Promise.allSettled([0, 1, 2, 3, 4].map((i) => swarm.spawn(rob, { commandId: `race${i}`, parentTaskId: root, title: `Child ${i}`, costMicros: 1000, computeMs: 10 })));
    assert.equal(results.filter((r) => r.status === "fulfilled").length, 3, JSON.stringify(results.map((r) => r.status)));
    for (const r of results) if (r.status === "rejected") assert.ok(r.reason instanceof DomainError && /live children/.test(r.reason.message), String(r.reason));
    assert.equal((await swarm.children(root, project)).length, 3, "exactly the limit is linked");
    const live = (await c.storage.listAggregates("task", { limit: 100 })).filter((t) => (t.body as { title?: string }).title?.startsWith("Child ") && (t.body as { state?: string }).state !== "cancelled");
    assert.equal(live.length, 3, "the refused ones were cancelled");
  } finally { await c.close(); rmSync(d, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }); }
});

after(stopServer);

for (const backend of backends) {
  const world = async (limit: number, tweak?: { failDelegate?: () => boolean; failAbandon?: () => boolean }) => {
    const w = await backend.open();
    const options = { clock: () => "2026-10-22T21:00:00.000Z", pause: async () => undefined };
    const projects = await ProjectService.open(w.storage, { holder: "c1", ...options });
    const principals = PrincipalService.withEpoch(w.storage, projects.epoch, options);
    const rob = await principals.authenticate((await principals.bootstrapOwner({ name: "rob" })).token);
    const project = (await projects.createProject({ commandId: "p1", actor: rob.id, name: "Garden" })).id;
    const root = (await projects.createTask({ commandId: "t-root", actor: rob.id, projectId: project, title: "Plant" })).id;
    const budgets = BudgetService.withEpoch(w.storage, projects.epoch, options);
    await budgets.open(rob, { commandId: "b-open", taskId: root, currency: "USD", costMicros: 1_000_000, computeMs: 60_000 });
    const contracts = ContractService.withEpoch(w.storage, projects.epoch, options);
    const pauses = PauseService.withEpoch(w.storage, projects.epoch, {}, options);
    // A wrapper that can make the allowance step fail and the clean-up cancel fail, as a crash between the claim and the link would leave things.
    const wrap = <T extends object>(target: T, name: string, override: (...a: never[]) => Promise<unknown>): T => new Proxy(target, { get: (t, k) => (k === name ? override : typeof (t as never)[k] === "function" ? ((t as never)[k] as (...a: unknown[]) => unknown).bind(t) : (t as never)[k]) });
    const flaky = wrap(budgets, "delegate", ((...a: Parameters<BudgetService["delegate"]>) => tweak?.failDelegate?.() === true ? Promise.reject(new Error("crash")) : budgets.delegate(...a)) as never);
    const proj = wrap(projects, "transitionTask", ((...a: Parameters<ProjectService["transitionTask"]>) => tweak?.failAbandon?.() === true ? Promise.reject(new Error("crash")) : projects.transitionTask(...a)) as never);
    const swarm = SwarmService.withEpoch(w.storage, projects.epoch, { projects: proj, contracts, budgets: flaky, stops: StopService.withEpoch(w.storage, projects.epoch, pauses, ports([])), limits: { depth: 2, children: limit } });
    const spawn = (id: string) => swarm.spawn(rob, { commandId: id, parentTaskId: root, title: `Child ${id}`, costMicros: 1000, computeMs: 10 });
    const gate = async () => ((await w.storage.getAggregate({ kind: "swarm-gate", id: root }))?.body as { children: string[] } | undefined)?.children ?? [];
    const finish = async (id: string) => { const t = (await projects.getTask(id))!; await projects.transitionTask({ commandId: `fin-${id}`, actor: rob.id, taskId: id, expectedRevision: t.revision, to: "cancelled" } as never); };
    return { w, swarm, spawn, gate, finish, root, project, rob };
  };
  const suite = (name: string, run: () => Promise<void>) => test(`${backend.name}: ${name}`, run);

  suite("spawns sent at the same moment cannot exceed the live-children limit (card H10 follow-up)", async () => {
    const x = await world(3);
    try {
      const results = await Promise.allSettled([0, 1, 2, 3, 4].map((i) => x.spawn(`race${i}`)));
      assert.equal(results.filter((r) => r.status === "fulfilled").length, 3, JSON.stringify(results.map((r) => r.status)));
      for (const r of results) if (r.status === "rejected") assert.ok(r.reason instanceof DomainError && /live children/.test(r.reason.message), String(r.reason));
      assert.equal((await x.swarm.children(x.root, x.project)).length, 3);
      assert.equal((await x.gate()).length, 3, "only the three linked children stay claimed");
    } finally { await x.w.close(); }
  });

  suite("a refused or cancelled child's claim is dropped on the next write and does not count", async () => {
    let fail = true;
    const x = await world(1, { failDelegate: () => fail });
    try {
      await assert.rejects(() => x.spawn("a"), /crash/);
      fail = false;
      // The failed child was cancelled by the clean-up, so its claim does not hold the only place.
      const ok = await x.spawn("b");
      assert.deepEqual(await x.gate(), [ok.taskId], "the failed child's claim was dropped by the next write");
      await assert.rejects(() => x.spawn("c"), /live children/);
      assert.deepEqual(await x.gate(), [ok.taskId], "a refusal leaves the claim list alone");
    } finally { await x.w.close(); }
  });

  suite("a child that cannot be cancelled after a failed spawn does not hold a place for good (its claim is dropped)", async () => {
    let crash = true;
    const x = await world(1, { failDelegate: () => crash, failAbandon: () => crash });
    try {
      await assert.rejects(() => x.spawn("a"), /crash/);
      assert.deepEqual(await x.gate(), [], "the orphan's claim was dropped though it could not be cancelled");
      crash = false;
      const ok = await x.spawn("b");
      assert.deepEqual(await x.gate(), [ok.taskId], "the place is free for a new child");
    } finally { await x.w.close(); }
  });

  suite("repeated spawn and finish cycles beyond the limit keep working and the claim list stays bounded", async () => {
    const x = await world(2);
    try {
      for (let i = 0; i < 12; i++) {
        const made = await x.spawn(`cyc${i}`);
        assert.ok((await x.gate()).length <= 2, `claims stay within the limit at cycle ${i}`);
        if (i % 2 === 1) for (const l of await x.swarm.children(x.root, x.project)) if ((await x.w.storage.getAggregate({ kind: "task", id: l.id }))?.body && (await x.gate()).includes(l.id)) { try { await x.finish(l.id); } catch { /* already final */ } }
        assert.ok(made.taskId);
      }
      assert.ok((await x.gate()).length <= 2);
    } finally { await x.w.close(); }
  });
}
