import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { ArtifactService, FileBlobStore } from "../artifacts/index.js";
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

test("status.attention and the chat's attention view name a deliverable accepted against a contract whose work changed since, through the composed controller (card U13)", async () => {
  const d = mkdtempSync(join(tmpdir(), "nn-attn-dlv-"));
  const c = await startController({ storage: { kind: "sqlite", path: join(d, "c.sqlite") }, argv: [], env: {}, print: () => undefined, facts: supported, filesystem: ext4, artifacts: { directory: join(d, "blobs") } });
  try {
    const s = c.services;
    const boot = await s.principals.bootstrapOwner({ name: "rob" });
    const owner = await s.principals.authenticate(boot.token);
    const call = async (op: string, args: Record<string, unknown>, commandId?: string) => (await c.api.handle(boot.token, { v: 1, op, ...(commandId === undefined ? {} : { commandId }), args } as never)) as any;
    const project = (await s.projects.createProject({ commandId: "p1", actor: owner.id, name: "Garden" })).id;
    const task = (await s.projects.createTask({ commandId: "t1", actor: owner.id, projectId: project, title: "Write the guide" })).id;
    const ann = await s.agents.create(owner, { commandId: "mk-ann", friendlyName: "Ann", roles: ["author"] });
    const artifacts = ArtifactService.withEpoch(c.storage, c.epoch, await FileBlobStore.open({ directory: join(d, "blobs") }));
    const art = (await artifacts.publish({ commandId: "a1", actor: owner.id, name: "guide", projectId: project, taskId: task, files: [{ path: "guide.txt", content: Buffer.from("the guide") }] })).id;
    assert.equal((await call("contract.set", { taskId: task, expectedVersion: 0, acceptanceCriteria: ["covers install"] }, "ct1")).ok, true);
    const made = await call("deliverable.draft", { taskId: task, type: "document", title: "Install guide", responsibleAgent: `agent:${ann.id}`, artifacts: [{ artifactId: art }] }, "d1");
    assert.equal(made.ok, true, JSON.stringify(made));
    const id = made.result.id;
    assert.equal((await call("deliverable.submit", { id, expectedRevision: made.result.revision, contractVersion: 1 }, "s1")).ok, true);
    assert.equal((await call("deliverable.review.start", { id, version: 1 }, "r1")).ok, true);
    assert.equal((await call("deliverable.accept", { id, version: 1 }, "a1")).ok, true);
    const stale = async () => ((await call("status.attention", { projectId: project, kind: "stale_artifact" })).result.items as any[]).filter((i) => i.detail.reason === "contract_changed");
    assert.deepEqual(await stale(), []);
    assert.equal((await call("contract.set", { taskId: task, expectedVersion: 1, priority: 9 }, "ct2")).ok, true);
    assert.deepEqual(await stale(), [], "a priority change leaves it as it is");
    assert.equal((await call("contract.set", { taskId: task, expectedVersion: 2, acceptanceCriteria: ["covers install", "covers upgrade"] }, "ct3")).ok, true);
    const items = await stale();
    assert.equal(items.length, 1);
    assert.deepEqual([items[0].kind, items[0].taskId, items[0].agentId, items[0].cite.kind, items[0].cite.id], ["stale_artifact", task, ann.id, "deliverable", id]);
    assert.deepEqual([items[0].detail.state, items[0].detail.checkedAgainst, items[0].detail.contractVersion, items[0].detail.fields], ["accepted", 1, 3, ["acceptanceCriteria"]]);
    const told = await call("status.ask", { request: { kind: "attention", projectId: project, attentionKind: "stale_artifact" } });
    assert.equal(told.ok, true, JSON.stringify(told));
    const text = (told.result.item.lines as { text: string }[]).map((l) => l.text).join("\n");
    assert.match(text, /Deliverable "Install guide" \(version 1, accepted\) on Write the guide was checked against contract version 1; the task's contract has since changed its acceptance criteria \(now version 3\)/);
    assert.ok(!text.includes("covers upgrade"), "the contract's own words are not shown");
    // A newer artifact of the same name replaces the one the accepted version names (`artifact_replaced`), through the state API and the chat.
    const replaced = async () => ((await call("status.attention", { projectId: project, kind: "stale_artifact" })).result.items as any[]).filter((i) => i.detail.reason === "artifact_replaced");
    assert.deepEqual(await replaced(), []);
    const newer = (await artifacts.publish({ commandId: "a2", actor: owner.id, name: "guide", projectId: project, taskId: task, files: [{ path: "guide.txt", content: Buffer.from("the guide, again") }] })).id;
    const r = await replaced();
    assert.equal(r.length, 1);
    assert.deepEqual([r[0].kind, r[0].agentId, r[0].cite.kind, r[0].cite.id, r[0].detail.artifacts], ["stale_artifact", ann.id, "deliverable", id, [{ artifactId: art, name: "guide", replacedBy: newer }]]);
    const told2 = await call("status.ask", { request: { kind: "attention", projectId: project, attentionKind: "stale_artifact" } });
    assert.match((told2.result.item.lines as { text: string }[]).map((l) => l.text).join("\n"), /Deliverable "Install guide" \(version 1, accepted\) on Write the guide names an artifact \("guide"\) that a newer artifact of the same name has replaced/);
  } finally { await c.close(); rmSync(d, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }); }
});
