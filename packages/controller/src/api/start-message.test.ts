import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { EnvironmentFacts, FilesystemDetector } from "../environment/index.js";
import { startController } from "./index.js";

const ext4: FilesystemDetector = async () => ({ type: "ext4", network: false });
const supported: EnvironmentFacts = { platform: "linux", arch: "x64", osRelease: "6.8.0-generic", nodeVersion: "22.19.0" };

test("an informational message sent through the state API reaches the agent at its check-in and not before, and is received once (card U12b)", async () => {
  const d = mkdtempSync(join(tmpdir(), "nn-msg-"));
  const c = await startController({ storage: { kind: "sqlite", path: join(d, "c.sqlite") }, argv: [], env: {}, print: () => undefined, facts: supported, filesystem: ext4, features: [] });
  try {
    const boot = await c.services.principals.bootstrapOwner({ name: "rob" });
    const rob = await c.services.principals.authenticate(boot.token);
    const call = async (token: string, op: string, args: Record<string, unknown>, commandId?: string) => (await c.api.handle(token, { v: 1, op, ...(commandId === undefined ? {} : { commandId }), args } as never)) as any;
    const project = (await call(boot.token, "project.create", { name: "Garden" }, "p1")).result.id as string;
    const task = (await call(boot.token, "task.create", { projectId: project, title: "weed" }, "t1")).result.id as string;
    const agent = (await c.services.agents.create(rob, { commandId: "ag-a", friendlyName: "A" })).id;
    const pid = `agent:${agent}`;
    const f = await c.storage.getAggregate({ kind: "principal", id: pid });
    await c.services.principals.setGrants(rob, { commandId: "g1", principalId: pid, expectedRevision: f!.revision, grants: [{ action: "task.read", project }, { action: "message.read", project }] as never });
    const tok = (await c.services.principals.issueCredential(rob, pid)).token;

    const sent = await call(boot.token, "message.send", { taskId: task, to: pid, class: "informational", purpose: "weather", text: "frost tonight" }, "m1");
    assert.ok(sent.ok, JSON.stringify(sent));
    assert.equal((await call(boot.token, "message.send", { taskId: task, to: pid, class: "informational", purpose: "weather", text: "frost tonight" }, "m1")).result.replayed, true);
    const read = await call(tok, "message.readable", { boundary: "check-in" });
    assert.ok(read.ok, JSON.stringify(read));
    assert.equal(read.result.item.items.length, 1);
    assert.equal(read.result.item.items[0].trust, "untrusted-content");
    const got = await call(tok, "message.receive", { boundary: "check-in", messageIds: [sent.result.id] }, "r1");
    assert.deepEqual(got.result.delivered, [sent.result.id], JSON.stringify(got));
    assert.equal((await call(tok, "message.readable", { boundary: "check-in" })).result.item.items.length, 0, "received once");
    const rel = await call(boot.token, "message.release", { recipient: pid });
    assert.ok(rel.ok, JSON.stringify(rel));
  } finally { await c.close(); rmSync(d, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }); }
});
