import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { ArtifactService, FileBlobStore } from "../artifacts/index.js";
import type { EnvironmentFacts, FilesystemDetector } from "../environment/index.js";
import { startController } from "./index.js";

const ext4: FilesystemDetector = async () => ({ type: "ext4", network: false });
const supported: EnvironmentFacts = { platform: "linux", arch: "x64", osRelease: "6.8.0-generic", nodeVersion: "22.19.0" };

test("deliverable.list and deliverable.get read a task's artifacts with the task's read right (card U13)", async () => {
  const d = mkdtempSync(join(tmpdir(), "nn-deliv-"));
  const c = await startController({ storage: { kind: "sqlite", path: join(d, "c.sqlite") }, argv: [], env: {}, print: () => undefined, facts: supported, filesystem: ext4, features: [], harnesses: [], artifacts: { directory: join(d, "blobs") } });
  try {
    const boot = await c.services.principals.bootstrapOwner({ name: "rob" });
    const rob = await c.services.principals.authenticate(boot.token);
    const call = async (token: string, op: string, args: Record<string, unknown>) => (await c.api.handle(token, { v: 1, op, args } as never)) as any;
    const project = (await c.services.projects.createProject({ commandId: "p1", actor: rob.id, name: "Garden" })).id;
    const task = (await c.services.projects.createTask({ commandId: "t1", actor: rob.id, projectId: project, title: "weed" })).id;
    const other = (await c.services.projects.createTask({ commandId: "t2", actor: rob.id, projectId: project, title: "water" })).id;
    const artifacts = ArtifactService.withEpoch(c.storage, c.epoch, await FileBlobStore.open({ directory: join(d, "blobs") }));
    const ids: string[] = [];
    for (const [n, t] of [["one", task], ["two", task], ["three", task], ["elsewhere", other]] as const) ids.push((await artifacts.publish({ commandId: `a-${n}`, actor: rob.id, name: n === "two" ? "key sk-live-ABCDEFGHIJKLMNOPQRSTUVWX1234" : n, projectId: project, taskId: t, files: [{ path: `${n}.txt`, content: Buffer.from(n) }] })).id);
    const tok = async (name: string, grants: { action: string; project: string }[]) => { await c.services.principals.enroll(rob, { commandId: `e-${name}`, kind: "agent", name, grants }); return (await c.services.principals.issueCredential(rob, `agent:${name}`)).token; };
    const ann = await tok("ann", [{ action: "task.read", project }]);
    const zed = await tok("zed", [{ action: "desk.read", project }]);

    const all = await call(boot.token, "deliverable.list", { taskId: task });
    assert.equal(all.ok, true, JSON.stringify(all));
    assert.equal(all.result.items.length, 3);
    const first = all.result.items[0];
    assert.deepEqual([first.taskId, first.projectId, first.createdBy, first.revision, first.files.length, typeof first.manifestDigest, typeof first.createdAt], [task, project, rob.id, 1, 1, "string", "string"]);
    assert.equal(all.result.items.some((i: any) => /sk-live/.test(i.name)), false, "names are redacted");
    assert.equal((await call(ann, "deliverable.list", { taskId: task })).result.items.length, 3, "the task's read right is enough");

    const refused = await call(zed, "deliverable.list", { taskId: task });
    assert.equal(refused.error.code, "not_found");
    assert.equal((await call(zed, "deliverable.get", { id: ids[0] })).error.code, "not_found");
    assert.equal((await call(boot.token, "deliverable.list", { taskId: task.slice(0, -1) + (task.endsWith("a") ? "b" : "a") })).error.code, "not_found");

    const p1 = await call(boot.token, "deliverable.list", { taskId: task, limit: 2 });
    assert.equal(p1.result.items.length, 2);
    assert.ok(p1.result.next);
    const p2 = await call(boot.token, "deliverable.list", { taskId: task, limit: 2, after: p1.result.next });
    assert.deepEqual([p2.result.items.length, p2.result.next], [1, undefined]);
    assert.deepEqual([...p1.result.items, ...p2.result.items].map((i: any) => i.id).sort(), all.result.items.map((i: any) => i.id).sort());
    for (const limit of [0, 101, 1.5, "5"]) assert.equal((await call(boot.token, "deliverable.list", { taskId: task, limit })).error.code, "invalid_command", String(limit));

    const one = await call(ann, "deliverable.get", { id: ids[0] });
    assert.deepEqual([one.ok, one.result.item.id, one.result.item.name], [true, ids[0], "one"]);
    assert.equal((await call(boot.token, "deliverable.get", { id: ids[0]!.slice(0, -1) + (ids[0]!.endsWith("a") ? "b" : "a") })).error.code, "not_found");
  } finally { await c.close(); rmSync(d, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }); }
});
