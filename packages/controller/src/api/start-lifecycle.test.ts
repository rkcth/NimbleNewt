import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { EnvironmentFacts, FilesystemDetector } from "../environment/index.js";
import { startController } from "./index.js";

const ext4: FilesystemDetector = async () => ({ type: "ext4", network: false });
const supported: EnvironmentFacts = { platform: "linux", arch: "x64", osRelease: "6.8.0-generic", nodeVersion: "22.19.0" };

test("suspend and stop through the state API: whoever may pause may ask, nothing live suspends at once, a stop ends and keeps the task as it was (card L02)", async () => {
  const d = mkdtempSync(join(tmpdir(), "nn-lifecycle-"));
  const c = await startController({ storage: { kind: "sqlite", path: join(d, "c.sqlite") }, argv: [], env: {}, print: () => undefined, facts: supported, filesystem: ext4, features: [], harnesses: [] });
  try {
    const boot = await c.services.principals.bootstrapOwner({ name: "rob" });
    const rob = await c.services.principals.authenticate(boot.token);
    const call = async (token: string, op: string, args: Record<string, unknown>, commandId?: string) => (await c.api.handle(token, { v: 1, op, ...(commandId === undefined ? {} : { commandId }), args } as never)) as any;
    const project = (await call(boot.token, "project.create", { name: "Garden" }, "p1")).result.id as string;
    const task = (await call(boot.token, "task.create", { projectId: project, title: "weed" }, "t1")).result.id as string;
    await c.services.principals.enroll(rob, { commandId: "e-ann", kind: "agent", name: "ann", grants: [{ action: "attempt.work", project }] });
    const ann = (await c.services.principals.issueCredential(rob, "agent:ann")).token;
    const scope = { kind: "task", id: task };
    // An agent without the grant is refused and nothing is paused.
    assert.equal((await call(ann, "lifecycle.stop", { scope, mode: "stop", reason: "x" }, "a1")).error.code, "forbidden");
    // Nothing is live: the suspension is complete at once, with its checkpoint trivially durable, and the task is paused but otherwise as it was.
    const suspended = await call(boot.token, "lifecycle.stop", { scope, mode: "suspend", reason: "maintenance" }, "s1");
    assert.ok(suspended.ok, JSON.stringify(suspended));
    assert.deepEqual([suspended.result.phase, suspended.result.outcome.state, suspended.result.outcome.graceful], ["done", "suspended", true]);
    assert.equal((await call(boot.token, "lifecycle.get", { intentId: suspended.result.intentId })).result.item.mode, "suspend");
    assert.equal((await call(ann, "lifecycle.get", { intentId: suspended.result.intentId })).error.code, "not_found", "another principal reads it like a missing one");
    // A replay is the same request.
    assert.equal((await call(boot.token, "lifecycle.stop", { scope, mode: "suspend", reason: "maintenance" }, "s1")).result.replayed, true);
    // Stop after suspend ends execution; the task is not cancelled.
    const stopped = await call(boot.token, "lifecycle.stop", { scope, mode: "stop", reason: "night" }, "s2");
    assert.deepEqual([stopped.result.phase, stopped.result.outcome.state], ["done", "stopped"]);
    assert.equal((await call(boot.token, "task.get", { taskId: task })).result.item.state, "proposed");
    // Bad input.
    assert.equal((await call(boot.token, "lifecycle.stop", { scope, mode: "nap", reason: "x" }, "s3")).error.code, "invalid_command");
    assert.equal((await call(boot.token, "lifecycle.stop", { scope: { kind: "installation", id: "nope" }, mode: "stop", reason: "x" }, "s4")).error.code, "invalid_command");
    assert.equal((await call(boot.token, "lifecycle.sweep", {}, "sw")).result.advanced.length, 0);
    assert.equal((await call(ann, "lifecycle.sweep", {}, "sw2")).error.code, "forbidden");
  } finally { await c.close(); rmSync(d, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }); }
});
