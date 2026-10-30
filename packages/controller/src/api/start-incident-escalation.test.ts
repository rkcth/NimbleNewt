import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { EnvironmentFacts, FilesystemDetector } from "../environment/index.js";
import { ManualTimer } from "../dispatch/testing/timer.js";
import { PI } from "../dispatch/testing/world.js";
import { startController } from "./index.js";

const ext4: FilesystemDetector = async () => ({ type: "ext4", network: false });
const supported: EnvironmentFacts = { platform: "linux", arch: "x64", osRelease: "6.8.0-generic", nodeVersion: "22.19.0" };

test("an escalated incident reaches the agent holding a task in the project once, an agent with none is retried without blocking the owner's, and the owner is told as before (card P04c)", async () => {
  const d = mkdtempSync(join(tmpdir(), "nn-inc-esc-"));
  const c = await startController({ storage: { kind: "sqlite", path: join(d, "c.sqlite") }, argv: [], env: {}, print: () => undefined, facts: supported, filesystem: ext4, features: [], harnesses: [PI], dispatch: { timer: new ManualTimer(), intervalMs: 1000 } });
  try {
    assert.ok(c.dispatch !== undefined, c.dispatchProblem);
    const s = c.services;
    const boot = await s.principals.bootstrapOwner({ name: "rob" });
    const owner = await s.principals.authenticate(boot.token);
    const call = (op: string, args: Record<string, unknown>, commandId?: string) => c.api.handle(boot.token, { v: 1, op, ...(commandId === undefined ? {} : { commandId }), args } as never) as Promise<{ ok: boolean; result?: any }>;
    const project = (await call("project.create", { name: "Ops" }, "p1")).result.id as string;
    for (const n of ["ann", "bob"]) await s.principals.enroll(owner, { commandId: `e-${n}`, kind: "agent", name: n, grants: [{ action: "task.read", project: "*" }] });
    // Ann holds an assigned task in the project; Bob holds none.
    const task = (await s.projects.createTask({ commandId: "t1", actor: owner.id, projectId: project, title: "Water the beds" })).id;
    await s.projects.transitionTask({ commandId: "r1", actor: owner.id, taskId: task, expectedRevision: 1, to: "ready" });
    await s.assignments.assignTask({ commandId: "as1", actor: owner.id, taskId: task, owner: { kind: "agent", id: "agent:ann" } });
    const incident = async (name: string, to: string): Promise<string> => {
      const duty = await call("responsibility.create", { projectId: project, title: name, objective: "Up", desiredCondition: "healthy", escalation: { to, afterAlerts: 2 } }, `r-${name}`);
      assert.equal(duty.ok, true, JSON.stringify(duty));
      for (const i of [0, 1]) assert.equal((await call("incident.report", { responsibilityId: duty.result.id, signature: name, summary: `step ${i}`, outcome: "failed" }, `i-${name}-${i}`)).ok, true);
      return duty.result.id as string;
    };
    const [forAnn, forBob, forOwner] = [await incident("disk", "agent:ann"), await incident("net", "agent:bob"), await incident("cpu", "owner")];
    const inbox = async (to: string) => (await c.storage.listAggregates("agent-message", { limit: 100 })).map((m) => m.body as unknown as { to: string; sender: string; kind: string; taskId: string; text: string }).filter((m) => m.to === to);
    const ownerNotices = async () => (await c.storage.listAggregates("notification-item", { limit: 100 })).filter((n) => JSON.stringify(n.body).includes("responsibility-incident")).length;
    const untold = async () => (await c.storage.listAggregates("responsibility-incident", { limit: 100 })).map((a) => a.body as unknown as { responsibilityId: string; escalatedAt?: string; notifiedAt?: string }).filter((b) => b.escalatedAt !== undefined && b.notifiedAt === undefined).map((b) => b.responsibilityId);

    for (let i = 0; i < 4; i++) await c.dispatch.dispatcher.tick();
    const told = await inbox("agent:ann");
    assert.equal(told.length, 1, "Ann is told once across several ticks");
    assert.deepEqual([told[0]!.sender, told[0]!.kind, told[0]!.taskId], ["controller", "notice", task]);
    assert.ok(told[0]!.text.includes(forAnn), told[0]!.text);
    assert.equal((await inbox("agent:bob")).length, 0, "Bob holds no task, so he is not told");
    assert.deepEqual(await untold(), [forBob], "Bob's incident stays untold, to be retried; nothing else does");
    assert.equal(await ownerNotices(), 1, "the owner's escalation reached the owner, once, though Bob's could not be sent");
    assert.ok(forOwner !== forBob);

    // Once Bob holds a task in the project, the retry tells him, once.
    const second = (await s.projects.createTask({ commandId: "t2", actor: owner.id, projectId: project, title: "Prune" })).id;
    await s.projects.transitionTask({ commandId: "r2", actor: owner.id, taskId: second, expectedRevision: 1, to: "ready" });
    await s.assignments.assignTask({ commandId: "as2", actor: owner.id, taskId: second, owner: { kind: "agent", id: "agent:bob" } });
    for (let i = 0; i < 3; i++) await c.dispatch.dispatcher.tick();
    assert.equal((await inbox("agent:bob")).length, 1);
    assert.equal((await inbox("agent:ann")).length, 1);
    assert.deepEqual(await untold(), []);
    assert.equal(await ownerNotices(), 1);
  } finally { await c.close(); rmSync(d, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }); }
});
