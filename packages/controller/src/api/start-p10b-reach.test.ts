import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { AdmissionService } from "../admission/service.js";
import type { HostLocalWork, WorkerHost, WorkOrder } from "../dispatch/index.js";
import { ManualTimer } from "../dispatch/testing/timer.js";
import { CommandRunner } from "../domain/runner.js";
import { PI, ScriptedWorker, workGrants } from "../dispatch/testing/world.js";
import type { EnvironmentFacts, FilesystemDetector } from "../environment/index.js";
import { HostService } from "../hosts/hosts.js";
import { LandingQueueService } from "../landing/index.js";
import { startController } from "./index.js";

// Card P10b (second clause and its follow-ups), through the composed controller: the woken integrator's attempt, on the task credential the dispatcher gave it (its work order's), takes its own project's lease, lists
// it, asks the pool, and reaches the landing's queue check under that lease; it reaches nothing of another project and no other workspace operation. A landing task's after-the-fact costs (review compute and its stop
// cleanup) are charged to the queued work's own task, never to the landing task. The owner's landing_queue view says when the landing task was released.
const ext4: FilesystemDetector = async () => ({ type: "ext4", network: false });
const supported: EnvironmentFacts = { platform: "linux", arch: "x64", osRelease: "6.8.0-generic", nodeVersion: "22.19.0" };
const CAPS = { os: "linux", arch: "x64", harnesses: [{ name: "pi", version: "1.3.0" }], isolation: ["bubblewrap"], tools: [], workspaces: [] };
const BASE = "a".repeat(40);

test("the woken integrator's attempt reaches its own project's lease and landing on its work order's credential, nothing else; its costs go to the queued work's task (card P10b)", async () => {
  const d = mkdtempSync(join(tmpdir(), "nn-p10b-reach-"));
  const orders: WorkOrder[] = [];
  const held = { cost: 0, attemptId: "" };
  const internal: string[] = [];
  // A local host whose agents run until they are stopped and which reports what a sandbox still holds (the cleanup cost a stop charges).
  const host = new ScriptedWorker("host:w1", async ({ order, worker }) => {
    orders.push(order);
    await new Promise<void>((done) => { const stop = worker.stop.bind(worker); worker.stop = async () => { await stop(); done(); }; });
    return { status: "completed", text: "stopped" };
  });
  (host as unknown as WorkerHost).localWork = async (): Promise<HostLocalWork> => ({ processes: [], costs: held.attemptId === "" ? [] : [{ attemptId: held.attemptId, costMicros: held.cost, computeMs: held.cost / 10 }] }) as never;
  const c = await startController({
    storage: { kind: "sqlite", path: join(d, "c.sqlite") }, argv: [], env: {}, print: () => undefined, facts: supported, filesystem: ext4, features: [], harnesses: [PI], onInternalError: (error: unknown) => { internal.push(error instanceof Error ? error.message : String(error)); },
    dispatch: { timer: new ManualTimer(), manual: true, route: async () => ({ route: "cloud/small", harness: "pi", role: "worker", request: { contextTokens: 1000, needs: [], data: "cloud-allowed", paidAuthorized: true } }), local: { acceptUnenforcedLimits: true, window: () => 8192, build: () => host } },
  } as never);
  const call = async (token: string, op: string, args: Record<string, unknown>, commandId?: string) => (await c.api.handle(token, { v: 1, op, ...(commandId === undefined ? {} : { commandId }), args } as never)) as any;
  try {
    assert.ok(c.dispatch !== undefined, c.dispatchProblem);
    const s = c.services;
    const boot = await s.principals.bootstrapOwner({ name: "rob" });
    const rob = await s.principals.authenticate(boot.token);
    const O = boot.token;
    await s.principals.enroll(rob, { commandId: "e-w1", kind: "host", name: "w1", grants: [] });
    const hostP = await s.principals.authenticate((await s.principals.issueCredential(rob, "host:w1")).token);
    const hosts = HostService.withEpoch(c.storage, c.epoch, s.assignments);
    await hosts.announce(hostP, { commandId: "an1", capabilities: CAPS as never });
    await hosts.heartbeat(hostP, { commandId: "hb1", sequence: 1 });
    await AdmissionService.withEpoch(c.storage, c.epoch).setCapacity({ commandId: "cap-w1", actor: rob.id, host: "host:w1", capacity: { cpus: 32, memoryMb: 65_536 } });
    const garden = (await s.projects.createProject({ commandId: "p1", actor: rob.id, name: "Garden" })).id;
    const orchard = (await s.projects.createProject({ commandId: "p2", actor: rob.id, name: "Orchard" })).id;
    for (const [i, project] of [garden, orchard].entries()) assert.ok((await call(O, "project.branches.change", { project, landing: "main" }, `lb${i}`)).ok);
    const lands = (project: string) => [...workGrants(project), { action: "integration.lease", project }, { action: "workspace.manage", project }];
    const hire = async (name: string, grants: { action: string; project: string }[]): Promise<string> => {
      const made = await s.agents.create(rob, { commandId: `mk-${name}`, friendlyName: name, roles: ["integrator"] });
      for (const [i, g] of grants.entries()) await s.grants.grant(rob, { commandId: `g-${name}-${i}`, grantee: `agent:${made.id}`, action: g.action, project: g.project, source: "direct", basis: "test" } as never);
      return made.id;
    };
    const ivy = await hire("Ivy", [...lands(garden), ...lands(orchard)]);
    const max = await hire("Max", lands(orchard));
    // Approved work queued on each project's landing branch (as the submissions would queue it).
    const queue = LandingQueueService.withEpoch(c.storage, c.epoch);
    const queued = async (projectId: string, n: number): Promise<string> => {
      const taskId = (await s.projects.createTask({ commandId: `t-${n}`, actor: rob.id, projectId, title: `Write part ${n}` })).id;
      await queue.enqueue({ commandId: `q-${n}`, actor: "controller", projectId, branch: "main", submissionId: `sbm-${"abcdefghij"[n]!.repeat(20)}`, taskId, base: BASE, tree: n.toString(16).padStart(40, "0"), author: "agent:writer" });
      return taskId;
    };
    const beans = await queued(garden, 1);
    const apples = await queued(orchard, 2);
    assert.ok((await call(O, "budget.open", { taskId: beans, currency: "USD", costMicros: 5_000_000, computeMs: 36_000_000 }, "bo")).ok);

    // The wake: Garden to ivy, Orchard to max. Ivy's landing attempt starts and runs on the credential in its work order.
    const round = await s.integratorWake.round();
    const expected = ivy < max ? [[garden, ivy], [orchard, max]] : undefined;
    if (expected !== undefined) assert.deepEqual(round.woken.map((w) => [w.projectId, w.agentId]), expected, JSON.stringify(round));
    else assert.deepEqual(round.woken.map((w) => w.projectId).sort(), [garden, orchard].sort(), JSON.stringify(round));
    assert.equal(round.woken.find((w) => w.projectId === garden)?.agentId, ivy, "only ivy may land on Garden");
    const landingTask = round.woken.find((w) => w.projectId === garden)!.taskId;
    const asg = (await s.assignments.getAssignment(landingTask))!;
    const attemptId = (await s.assignments.admitAttempt({ commandId: "adm-l", actor: "inbox", taskId: landingTask, expectedRevision: asg.revision, generation: asg.generation, owner: { kind: "agent", id: ivy }, harness: "pi" } as never)).id;
    const tick = await c.dispatch.dispatcher.tick();
    const blockers = await Promise.all(tick.blocked.map(async (b) => (await c.storage.getAggregate({ kind: "blocker", id: b.blockerId }))?.body));
    for (let i = 0; i < 200 && orders.length === 0; i++) await new Promise((resolve) => setTimeout(resolve, 10));
    const order = orders.find((o) => o.attemptId === attemptId)!;
    assert.ok(order !== undefined, JSON.stringify([tick, blockers]));
    const T = order.credential;
    assert.ok(T.startsWith("tcr-"));

    // Its own project's lease: taken, listed, the pool answers that hold.
    const took = await call(T, "integrator.lease.acquire", { taskId: beans, branch: "main", ttlMs: 600_000 }, "take");
    assert.equal(took.ok, true, JSON.stringify(took));
    assert.deepEqual([took.result.item.projectId, took.result.item.holder], [garden, ivy]);
    const listed = await call(T, "integrator.lease.list", { projectId: garden });
    assert.deepEqual(listed.result.items.map((l: { branch: string }) => l.branch), ["main"]);
    const pool = await call(T, "integrator.pool.next", { ttlMs: 600_000 }, "pool");
    assert.deepEqual([pool.result.outcome, pool.result.projectId], ["holding", garden], JSON.stringify(pool));
    // The landing under that lease gets past the door and the lease to the queue's own judgement (this queue entry has no approval record, so the queue refuses it: nothing was landed).
    const landing = await call(T, "workspace.request", { operation: "landing", taskId: beans, reason: "land the first place", leaseId: took.result.item.leaseId, fence: took.result.item.fence }, "land");
    assert.equal(landing.ok, false, JSON.stringify(landing));
    assert.equal(landing.error.code, "review_invalid", JSON.stringify(landing));
    // Nothing of Orchard, and no other operation.
    const other = await call(T, "integrator.lease.acquire", { taskId: apples, branch: "main", ttlMs: 600_000 }, "take-o");
    assert.deepEqual([other.ok, other.error?.code], [false, "not_found"], JSON.stringify(other));
    assert.deepEqual([(await call(T, "integrator.lease.list", { projectId: orchard })).error?.code], ["not_found"]);
    const otherLanding = await call(T, "workspace.request", { operation: "landing", taskId: apples, reason: "x", leaseId: took.result.item.leaseId, fence: took.result.item.fence }, "land-o");
    assert.equal(otherLanding.error?.code, "not_found", JSON.stringify(otherLanding));
    const refresh = await call(T, "workspace.request", { operation: "refresh", taskId: beans, reason: "x" }, "refresh");
    assert.deepEqual([refresh.ok, refresh.error?.code], [false, "forbidden"], JSON.stringify(refresh));

    // Costs after the fact: review compute charged by task, and the cleanup a stop bills, land on the queued work's task.
    await c.dispatch.chargeUse({ commandId: "rv-1", activity: "review", taskId: landingTask, agentId: `agent:${ivy}`, computeMs: 25 });
    held.attemptId = attemptId; held.cost = 7000;
    const stop = await call(O, "lifecycle.stop", { scope: { kind: "task", id: landingTask }, mode: "stop", reason: "night" }, "st1");
    assert.ok(stop.ok, JSON.stringify(stop));
    const usage = (await call(O, "budget.usage", { taskId: beans })).result.item.byActivity;
    assert.deepEqual([usage["review"]?.computeMs, usage["stop-cleanup"]?.costMicros], [25, 7000], JSON.stringify(usage));
    const entries = (await c.storage.listAggregates("budget-entry", { limit: 1000 })).map((e) => e.body as { taskId?: string });
    assert.ok(entries.every((e) => e.taskId !== landingTask), "nothing is charged to the landing task");
    // Second review: a review charge whose pin is damaged is not lost (the retry store keeps only a charge that reached it). It is booked where the landing task's costs go now (the queued work's task), and the
    // damage is reported; the damaged pin is left as it is, never read as some task.
    const pinId = `icp-${createHash("sha256").update(`${landingTask}\0rv-2`).digest("hex").slice(0, 32)}`;
    const damaged = { taskId: landingTask, commandId: "rv-2", budgetTaskId: "../x" };
    await new CommandRunner(c.storage, c.epoch, {}).command("test.raw", { commandId: "raw-pin", actor: "test" }, async () => ({ payload: {}, build: async () => ({ ref: { kind: "landing-charge-pin", id: pinId }, creates: true, changes: [{ type: "create" as const, ref: { kind: "landing-charge-pin", id: pinId }, body: damaged }], detail: {} }) }));
    await c.dispatch.chargeUse({ commandId: "rv-2", activity: "review", taskId: landingTask, agentId: `agent:${ivy}`, computeMs: 5 });
    assert.equal((await call(O, "budget.usage", { taskId: beans })).result.item.byActivity["review"]?.computeMs, 30);
    assert.ok(internal.some((m) => m.includes("rv-2") && m.includes("damaged")), JSON.stringify(internal));
    assert.deepEqual((await c.storage.getAggregate({ kind: "landing-charge-pin", id: pinId }))?.body, damaged);

    // The owner's view after the landing task was released: said as it is.
    await call(O, "integrator.lease.release", { projectId: garden, branch: "main" }, "rel-lease");
    const now = (await s.assignments.getAssignment(landingTask))!;
    await s.assignments.releaseTask({ commandId: "rel-1", actor: rob.id, taskId: landingTask, expectedRevision: now.revision, reason: "the owner's choice" } as never);
    // Card P10b, fifth slice: each charge's task was fixed at its first try (one pin per charge: the review's and the stop's), so the review charge made again under its command ID after the release still names
    // the queued work's task and settles as the same charge (no second entry, nothing kept to retry), though the landing task is no longer the integrator's.
    assert.equal((await c.storage.listAggregates("landing-charge-pin", { limit: 10 })).length, 3, "the review's, the stop's and the damaged one");
    await c.dispatch.chargeUse({ commandId: "rv-1", activity: "review", taskId: landingTask, agentId: `agent:${ivy}`, computeMs: 25 });
    assert.deepEqual([(await call(O, "budget.usage", { taskId: beans })).result.item.byActivity["review"]?.computeMs, (await c.storage.listAggregates("charge-retry", { limit: 10 })).length], [30, 0]);
    const view = await call(O, "status.ask", { request: { kind: "landing_queue", projectId: garden } });
    const text = (view.result.item.lines as { text: string }[]).map((l) => l.text).join("\n");
    assert.match(text, new RegExp(`landing task ${landingTask}, but that task was released and is assigned to nobody now`), text);
    // The released task's credential reaches nothing now.
    const after = await call(T, "integrator.lease.list", { projectId: garden });
    assert.equal(after.ok, false, JSON.stringify(after));
  } finally { await c.close(); rmSync(d, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }); }
});
