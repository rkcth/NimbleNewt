import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { stopServer } from "../domain/testing/backends.js";
import { ManualTimer } from "../dispatch/testing/timer.js";
import { PI } from "../dispatch/testing/world.js";
import type { EnvironmentFacts, FilesystemDetector } from "../environment/index.js";
import { startTestServer, type TestServer } from "../storage/postgres/testing/server.js";
import { startController, type Controller as StartedController } from "./start.js";

after(stopServer);

const ext4: FilesystemDetector = async () => ({ type: "ext4", network: false });
const supported: EnvironmentFacts = { platform: "linux", arch: "x64", osRelease: "6.8.0-generic", nodeVersion: "22.19.0" };
type Reply = { ok: boolean; result?: any; error?: { code: string; message?: string } };
type Storage = "sqlite" | { pg: TestServer };
type Choice = { kind: "sqlite"; path: string } | { kind: "postgres"; url: string; schema: string };
const choiceOf = (storage: Storage, d: string): Choice => storage === "sqlite" ? { kind: "sqlite", path: join(d, "c.sqlite") } : { kind: "postgres", url: storage.pg.url(), schema: `p04ap_${process.pid}_${Math.random().toString(36).slice(2, 8)}` };
const open = (choice: Choice): Promise<StartedController> => startController({ storage: choice, argv: [], env: {}, print: () => undefined, facts: supported, filesystem: ext4, features: [], harnesses: [PI], admitAssigned: true,
  dispatch: { timer: new ManualTimer(), intervalMs: 1000, route: async () => ({ route: "cloud/small", harness: "pi", role: "worker", request: { contextTokens: 1000, needs: [], data: "cloud-allowed", paidAuthorized: true } }) } } as never);

/**
 * Card P04 (flip audit): pausing the maintenance agent itself (the lifecycle pause of the agent, not the responsibility's own `paused` state). While the agent is paused its responsibility keeps its owner, an open incident
 * and the escalation notice to the agent stay queued, and a due check opens one task that is held (no attempt) and is not counted as a task that ended with no check entry nor as a check not taken. After the resume the task
 * is started and the queued notice reaches the agent.
 */
async function pausedAgent(storage: Storage): Promise<void> {
  const d = mkdtempSync(join(tmpdir(), "nn-p04-pause-"));
  const c = await open(choiceOf(storage, d));
  try {
    assert.ok(c.dispatch !== undefined, c.dispatchProblem);
    const boot = await c.services.principals.bootstrapOwner({ name: "rob" });
    const owner = await c.services.principals.authenticate(boot.token);
    const as = (token: string) => (op: string, args: Record<string, unknown>, commandId?: string) => c.api.handle(token, { v: 1, op, ...(commandId === undefined ? {} : { commandId }), args } as never) as Promise<Reply>;
    const call = as(boot.token);
    let failedLoops: unknown[] = [];
    const tickN = async (k = 4): Promise<void> => { for (let i = 0; i < k; i++) failedLoops = ((await c.dispatch!.dispatcher.tick()).loops ?? []).filter((l) => !l.ok); };
    const project = (await call("project.create", { name: "Ops" }, "p1")).result.id as string;
    const agent = (await call("agent.create", { friendlyName: "Ann" }, "ag1")).result.id as string;
    const principal = `agent:${agent}`;
    // The agent may read the project's tasks, so the controller may tell it about the check task it holds (the escalation notice is filed against that task).
    const granted = await call("grant.create", { grantee: principal, action: "task.read", project, basis: "it answers for the responsibility" }, "g1");
    assert.ok(granted.ok, JSON.stringify(granted));
    const made = await call("responsibility.create", { projectId: project, title: "Keep web up", objective: "Up", desiredCondition: "web answers", everyMinutes: 60, ownerId: principal, escalation: { to: principal, afterAlerts: 2 } }, "r1");
    assert.ok(made.ok, JSON.stringify(made));
    const duty = made.result.id as string;
    // The responsibility began long ago, so a check is due at once (the stored time is moved back, as the clock cannot be: no real wait).
    const long = new Date(Date.now() - 3 * 3_600_000).toISOString();
    const realGet = c.storage.getAggregate.bind(c.storage);
    const realList = c.storage.listAggregates.bind(c.storage);
    const back = (a: any) => (a?.kind === "responsibility" ? { ...a, createdAt: long, updatedAt: long } : a);
    c.storage.getAggregate = async (ref) => back(await realGet(ref));
    c.storage.listAggregates = (async (kind: string, o: any) => (await realList(kind, o)).map(back)) as never;

    const paused = await call("lifecycle.pause", { scope: { kind: "agent", id: agent }, reason: "the agent is being looked at" }, "pz1");
    assert.ok(paused.ok, JSON.stringify(paused));
    // Two alerts: the incident is due for escalation at once (afterAlerts 2), no wait needed.
    for (const k of ["i1", "i2"]) assert.ok((await call("incident.report", { responsibilityId: duty, signature: "web-down", summary: "web does not answer", outcome: "failed" }, k)).ok);

    const tasks = async () => (await c.storage.listAggregates("task", { limit: 50 })).filter((t) => (t.body as { title?: string }).title === "Check: Keep web up");
    const attempts = async (taskId: string) => (await c.services.assignments.getAssignment(taskId))?.attempts ?? 0;
    const notices = async () => (await c.storage.listAggregates("agent-message", { limit: 50 })).filter((m) => (m.body as { to?: string; purpose?: string }).to === principal && (m.body as { purpose?: string }).purpose === "An incident was escalated to you");
    const history = async () => (await call("responsibility.history", { responsibilityId: duty, limit: 100 })).result.items as { kind: string; summary: string; outcome?: string }[];

    const whilePaused = async (label: string): Promise<string> => {
      assert.equal((await call("responsibility.get", { responsibilityId: duty })).result.item.ownerId, principal, `${label}: the responsibility keeps its owner`);
      assert.equal((await call("lifecycle.status", { scope: { kind: "agent", id: agent } })).result.item.intent, "pause", label);
      const open = (await call("responsibility.incidents", { projectId: project, open: true })).result.items as any[];
      assert.deepEqual(open.map((i) => [i.responsibilityId, i.state, i.count, i.escalatedAt !== undefined]), [[duty, "open", 2, true]], `${label}: the incident stays open and escalated`);
      const t = await tasks();
      assert.equal(t.length, 1, `${label}: one check task, not one per tick: ${JSON.stringify(t.map((x) => x.body))}`);
      const taskId = t[0]!.id;
      assert.equal((await call("assignment.get", { taskId })).result.item.owner.id, agent, `${label}: given to the answering agent`);
      assert.equal(await attempts(taskId), 0, `${label}: held, not run, while the agent is paused`);
      assert.ok(!["done", "cancelled"].includes((t[0]!.body as { state: string }).state), `${label}: the task has not ended, so it is not tried again as one that ended with no check entry`);
      const owed = (await call("responsibility.checks", { projectId: project })).result.items as any[];
      assert.deepEqual(owed.map((x) => [x.run?.how, x.run?.attempt ?? 1, x.run?.taskId]), [["task", 1, taskId]], `${label}: still owed, taken up by the one task, first try`);
      const h = await history();
      assert.deepEqual(h.filter((x) => x.kind === "check"), [], `${label}: no check entry (not 'not taken', not 'ended with no check entry')`);
      assert.ok(!h.some((x) => /not taken|without a recorded result/.test(x.summary)), JSON.stringify(h));
      assert.equal((await call("responsibility.observed", { responsibilityId: duty })).result.item.observed, "unknown", `${label}: no check yet, so not healthy (and not judged)`);
      const n = await notices();
      assert.equal(n.length, 1, `${label}: one escalation notice to the agent: ${JSON.stringify((await c.storage.listAggregates("agent-message", { limit: 50 })).map((m) => m.body))} ${JSON.stringify(failedLoops)}`);
      assert.equal((n[0]!.body as { state: string }).state, "accepted", `${label}: not delivered`);
      assert.equal((await call("message.get", { messageId: n[0]!.id })).result.item.reachNow, "queued", `${label}: queued while the agent is paused`);
      assert.ok(((await call("message.inbox", { recipient: principal })).result.item.items as { id: string; reachNow: string }[]).some((p) => p.id === n[0]!.id && p.reachNow === "queued"), `${label}: waiting in the inbox`);
      assert.deepEqual(failedLoops, [], `${label}: every loop of the last tick ran`);
      return taskId;
    };

    await tickN();
    const taskId = await whilePaused("after the first ticks");
    await tickN(6);
    assert.equal(await whilePaused("after more ticks"), taskId);

    const resumed = await call("lifecycle.resume", { scope: { kind: "agent", id: agent }, reason: "done looking" }, "rs1");
    assert.ok(resumed.ok, JSON.stringify(resumed));
    await tickN();
    assert.deepEqual(failedLoops, []);
    assert.equal(await attempts(taskId), 1, "the held task is started once the pause is lifted");
    assert.equal((await tasks()).length, 1);
    const [notice] = await notices();
    assert.equal((await call("message.get", { messageId: notice!.id })).result.item.reachNow, "ready", "the queued notice can be delivered now");
    const annToken = (await c.services.principals.issueCredential(owner, principal)).token;
    const asAnn = as(annToken);
    const readable = await asAnn("message.readable", { boundary: "safe-boundary" });
    assert.ok(readable.ok, JSON.stringify(readable));
    assert.ok((readable.result.item.items as { id: string }[]).some((m) => m.id === notice!.id), JSON.stringify(readable.result));
    const got = await asAnn("message.receive", { boundary: "safe-boundary", messageIds: [notice!.id] }, "rc1");
    assert.deepEqual(got.result?.delivered, [notice!.id], JSON.stringify(got));
    assert.equal(((await c.storage.getAggregate({ kind: "agent-message", id: notice!.id }))!.body as { state: string }).state, "delivered");
    assert.equal((await call("responsibility.get", { responsibilityId: duty })).result.item.ownerId, principal);
  } finally { await c.close(); rmSync(d, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }); }
}

test("through the running controller: a paused maintenance agent keeps its responsibility; its incident notice stays queued and a due check opens one held task, neither 'not taken' nor retried; after the resume the task starts and the notice is delivered (SQLite; card P04)", async () => { await pausedAgent("sqlite"); });

test("the same on PostgreSQL (card P04)", async () => {
  const pg = await startTestServer();
  try { await pausedAgent({ pg }); } finally { await pg.stop(); }
});
