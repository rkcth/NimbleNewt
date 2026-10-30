import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { EnvironmentFacts, FilesystemDetector } from "../environment/index.js";
import { startController } from "./index.js";
import { OPERATION_BY_NAME } from "./operations.js";

const ext4: FilesystemDetector = async () => ({ type: "ext4", network: false });
const supported: EnvironmentFacts = { platform: "linux", arch: "x64", osRelease: "6.8.0-generic", nodeVersion: "22.19.0" };

test("status.attention lists a paused assignee through the state API of the composed controller, paged, with the neighbours' rights (card U13)", async () => {
  const d = mkdtempSync(join(tmpdir(), "nn-attn-"));
  const c = await startController({ storage: { kind: "sqlite", path: join(d, "c.sqlite") }, argv: [], env: {}, print: () => undefined, facts: supported, filesystem: ext4 });
  try {
    const s = c.services;
    const boot = await s.principals.bootstrapOwner({ name: "rob" });
    const owner = await s.principals.authenticate(boot.token);
    const call = async (token: string, args: Record<string, unknown>) => (await c.api.handle(token, { v: 1, op: "status.attention", args } as never)) as any;
    const project = (await s.projects.createProject({ commandId: "p1", actor: owner.id, name: "Garden" })).id;
    const tasks: string[] = [];
    for (const n of [1, 2, 3]) {
      const id = (await s.projects.createTask({ commandId: `t${n}`, actor: owner.id, projectId: project, title: `weed ${n}` })).id;
      await s.projects.transitionTask({ commandId: `r${n}`, actor: owner.id, taskId: id, expectedRevision: 1, to: "ready" });
      await s.assignments.assignTask({ commandId: `as${n}`, actor: owner.id, taskId: id, owner: { kind: "agent", id: "ann" } });
      await s.pauses.pause(owner, { commandId: `pz${n}`, scope: { kind: "task", id }, reason: "look first" });
      tasks.push(id);
    }
    await s.principals.enroll(owner, { commandId: "e-reader", kind: "agent", name: "reader", grants: [{ action: "task.read", project }] });
    await s.principals.enroll(owner, { commandId: "e-assigner", kind: "agent", name: "assigner", grants: [{ action: "task.read", project }, { action: "assignment.read", project }] });
    const reader = (await s.principals.issueCredential(owner, "agent:reader")).token;
    const assigner = (await s.principals.issueCredential(owner, "agent:assigner")).token;

    const all = await call(boot.token, { projectId: project });
    assert.equal(all.ok, true, JSON.stringify(all));
    assert.deepEqual(all.result.items.map((i: any) => i.taskId).sort(), [...tasks].sort());
    assert.ok(all.result.items.every((i: any) => i.kind === "paused_assignee" && i.agentId === "ann" && i.projectId === project));
    assert.equal(all.result.next, undefined);
    const p1 = await call(boot.token, { projectId: project, limit: 2 });
    assert.equal(p1.result.items.length, 2);
    assert.ok(p1.result.next);
    const p2 = await call(boot.token, { projectId: project, limit: 2, after: p1.result.next });
    assert.deepEqual([p2.result.items.length, p2.result.next], [1, undefined]);
    assert.deepEqual([...p1.result.items, ...p2.result.items].map((i: any) => i.taskId).sort(), [...tasks].sort());
    assert.deepEqual((await call(boot.token, { taskId: tasks[0] })).result.items.map((i: any) => i.taskId), [tasks[0]]);
    assert.equal((await call(boot.token, { projectId: project, agentId: "bob" })).result.items.length, 0);

    assert.equal((await call(reader, { projectId: project })).result.items.length, 0, "the task right alone shows no pauses");
    assert.equal((await call(assigner, { projectId: project })).result.items.length, 3, "the assignment right shows them");
    assert.equal((await call(reader, {})).error.code, "forbidden");
    for (const bad of [{ limit: 0 }, { limit: 101 }, { limit: "3" }, { kind: "x" }, { since: "x" }, { agentId: 5 }, { extra: 1 }]) assert.equal((await call(boot.token, { projectId: project, ...bad })).error.code, "invalid_command", JSON.stringify(bad));

    // A task credential may ask about its own task only.
    const op = OPERATION_BY_NAME.get("status.attention")!;
    const ctx = { principal: { id: "agent:ann", kind: "agent", name: "ann", grants: [], taskScope: { taskId: tasks[0], projectId: project } }, status: { attention: async () => ({ observedAt: "x", items: [] }) } } as never;
    await assert.rejects(() => op.run(ctx, {}, undefined), (e: { code?: string }) => e.code === "forbidden");
    await assert.rejects(() => op.run(ctx, { taskId: tasks[1] }, undefined), (e: { code?: string }) => e.code === "not_found");
    assert.deepEqual(await op.run(ctx, { taskId: tasks[0] }, undefined), { observedAt: "x", items: [] });
  } finally { await c.close(); rmSync(d, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }); }
});
