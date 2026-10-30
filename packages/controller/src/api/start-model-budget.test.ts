import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { EnvironmentFacts, FilesystemDetector } from "../environment/index.js";
import { startController } from "./index.js";

const ext4: FilesystemDetector = async () => ({ type: "ext4", network: false });
const supported: EnvironmentFacts = { platform: "linux", arch: "x64", osRelease: "6.8.0-generic", nodeVersion: "22.19.0" };

test("the owner sets and reads a task's model limits through the state API, a limit left out keeps its value, others are refused, and the limits survive a restart (card V02)", async () => {
  const d = mkdtempSync(join(tmpdir(), "nn-mb-"));
  const open = () => startController({ storage: { kind: "sqlite", path: join(d, "c.sqlite") }, argv: [], env: {}, print: () => undefined, facts: supported, filesystem: ext4 });
  try {
    const first = await open();
    const boot = await first.services.principals.bootstrapOwner({ name: "rob" });
    const rob = await first.services.principals.authenticate(boot.token);
    const project = (await first.services.projects.createProject({ commandId: "p1", actor: rob.id, name: "Garden" })).id;
    const task = (await first.services.projects.createTask({ commandId: "t1", actor: rob.id, projectId: project, title: "Build" })).id;
    await first.services.principals.enroll(rob, { commandId: "e1", kind: "agent", name: "zed", grants: [{ action: "task.read", project: "*" }] });
    const zed = (await first.services.principals.issueCredential(rob, "agent:zed")).token;
    const call = (token: string, op: string, args: Record<string, unknown>, commandId?: string) => first.api.handle(token, { v: 1, op, ...(commandId === undefined ? {} : { commandId }), args } as never) as Promise<any>;
    assert.equal((await call(boot.token, "model-budget.set", { taskId: task, maxFailedAttempts: 5 }, "b1")).ok, true);
    assert.equal((await call(boot.token, "model-budget.set", { taskId: task, maxTokens: 9000 }, "b2")).ok, true);
    const got = await call(boot.token, "model-budget.get", { taskId: task });
    assert.deepEqual([got.result.budget.maxFailedAttempts, got.result.budget.maxTokens], [5, 9000]);
    assert.deepEqual(got.result.spent, { costMicros: 0, tokens: 0, calls: 0, failures: 0 });
    for (const [op, args, id] of [["model-budget.set", { taskId: task, maxFailedAttempts: 99 }, "z1"], ["model-budget.get", { taskId: task }, undefined]] as const) {
      const r = await call(zed, op, args as never, id);
      assert.equal(r.ok, false, op);
      assert.ok(["forbidden", "not_found"].includes(r.error.code), `${op}: ${r.error.code}`);
    }
    assert.equal((await call(boot.token, "model-budget.set", { taskId: task, maxFailedAttempts: -1 }, "b3")).ok, false);
    await first.close();
    const second = await open();
    const again = (await second.api.handle(boot.token, { v: 1, op: "model-budget.get", args: { taskId: task } } as never)) as any;
    assert.equal(again.result.budget.maxFailedAttempts, 5);
    await second.close();
  } finally { rmSync(d, { recursive: true, force: true }); }
});
