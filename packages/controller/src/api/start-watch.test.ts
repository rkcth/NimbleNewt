import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { EventService } from "../events/index.js";
import type { EnvironmentFacts, FilesystemDetector } from "../environment/index.js";
import { ManualTimer } from "../dispatch/testing/timer.js";
import { startController } from "./index.js";

const ext4: FilesystemDetector = async () => ({ type: "ext4", network: false });
const supported: EnvironmentFacts = { platform: "linux", arch: "x64", osRelease: "6.8.0-generic", nodeVersion: "22.19.0" };

test("the owner creates a watch through the state API and the running controller hands a matching event to the task's owner once (card H13b)", async () => {
  const d = mkdtempSync(join(tmpdir(), "nn-watch-"));
  const c = await startController({ storage: { kind: "sqlite", path: join(d, "c.sqlite") }, argv: [], env: {}, print: () => undefined, facts: supported, filesystem: ext4, features: [], dispatch: { timer: new ManualTimer(), intervalMs: 1000 } });
  try {
    assert.ok(c.dispatch !== undefined, c.dispatchProblem);
    const boot = await c.services.principals.bootstrapOwner({ name: "rob" });
    const rob = await c.services.principals.authenticate(boot.token);
    const call = async (token: string, op: string, args: Record<string, unknown>, commandId?: string) => (await c.api.handle(token, { v: 1, op, ...(commandId === undefined ? {} : { commandId }), args } as never)) as any;
    const project = (await call(boot.token, "project.create", { name: "Garden" }, "p1")).result.id as string;
    const task = (await call(boot.token, "task.create", { projectId: project, title: "weed" }, "t1")).result.id as string;
    const agent = (await c.services.agents.create(rob, { commandId: "ag-a", friendlyName: "A" })).id;
    await call(boot.token, "task.transition", { taskId: task, to: "ready", expectedRevision: 1 }, "tr1");
    assert.ok((await call(boot.token, "task.assign", { taskId: task, owner: { kind: "agent", id: agent } }, "as1")).ok);
    await c.services.principals.enroll(rob, { commandId: "e-zed", kind: "agent", name: "zed", grants: [{ action: "task.read", project }] });
    const zed = (await c.services.principals.issueCredential(rob, "agent:zed")).token;

    assert.equal((await call(zed, "watch.create", { stream: `project:${project}`, taskId: task }, "w0")).error.code, "forbidden");
    const made = await call(boot.token, "watch.create", { stream: `project:${project}`, taskId: task }, "w1");
    assert.ok(made.ok, JSON.stringify(made));
    assert.equal((await call(boot.token, "watch.create", { stream: `project:${project}`, taskId: task }, "w1")).result.replayed, true);
    assert.equal((await call(boot.token, "watch.create", { stream: "project:proj-zzzzzzzzzzzzzzzzzzzz", taskId: task }, "w2")).ok, false, "a stream that is not the task's or its project's");
    assert.deepEqual((await call(boot.token, "watch.list", {})).result.items, [made.result.id]);

    const events = EventService.withEpoch(c.storage, c.epoch);
    await events.publish(rob, { commandId: "pb1", stream: `project:${project}`, kind: "task.updated", ref: { kind: "task", id: task } } as never);
    const inbox = async () => (await c.storage.listAggregates("inbox-message", { limit: 50 })).filter((m) => JSON.stringify(m.body).includes("event-wake")).length;
    assert.equal(await inbox(), 0);
    await c.dispatch.dispatcher.tick();
    assert.equal(await inbox(), 1, "the event reached the owner as one inbox item");
    await c.dispatch.dispatcher.tick();
    assert.equal(await inbox(), 1, "not handed over twice");
    assert.ok((await call(boot.token, "watch.cancel", { watchId: made.result.id }, "w3")).ok);
    assert.deepEqual((await call(boot.token, "watch.list", {})).result.items, []);
  } finally { await c.close(); rmSync(d, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }); }
});
