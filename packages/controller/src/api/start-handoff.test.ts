import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { EnvironmentFacts, FilesystemDetector } from "../environment/index.js";
import { startController } from "./index.js";

const ext4: FilesystemDetector = async () => ({ type: "ext4", network: false });
const supported: EnvironmentFacts = { platform: "linux", arch: "x64", osRelease: "6.8.0-generic", nodeVersion: "22.19.0" };

test("a task is handed to another agent through the state API: prepared, package from the contract, incomplete until the gap is accepted, then moved once (card L03b)", async () => {
  const d = mkdtempSync(join(tmpdir(), "nn-handoff-"));
  const c = await startController({ storage: { kind: "sqlite", path: join(d, "c.sqlite") }, argv: [], env: {}, print: () => undefined, facts: supported, filesystem: ext4, features: [], harnesses: [] });
  try {
    const boot = await c.services.principals.bootstrapOwner({ name: "rob" });
    const rob = await c.services.principals.authenticate(boot.token);
    const call = async (token: string, op: string, args: Record<string, unknown>, commandId?: string) => (await c.api.handle(token, { v: 1, op, ...(commandId === undefined ? {} : { commandId }), args } as never)) as any;
    const project = (await call(boot.token, "project.create", { name: "Garden" }, "p1")).result.id as string;
    const task = (await call(boot.token, "task.create", { projectId: project, title: "weed the beds", description: "Clear the north beds." }, "t1")).result.id as string;
    const a = (await c.services.agents.create(rob, { commandId: "ag-a", friendlyName: "A" })).id;
    const b = (await c.services.agents.create(rob, { commandId: "ag-b", friendlyName: "B" })).id;
    await c.services.contracts.setContract(rob, { commandId: "ct1", taskId: task, expectedVersion: 0, acceptanceCriteria: ["beds are clear", "photos attached"] } as never);
    await call(boot.token, "task.transition", { taskId: task, to: "ready", expectedRevision: 1 }, "tr1");
    assert.ok((await call(boot.token, "task.assign", { taskId: task, owner: { kind: "agent", id: a } }, "as1")).ok);
    await c.services.principals.enroll(rob, { commandId: "e-zed", kind: "agent", name: "zed", grants: [{ action: "task.read", project }] });
    const zed = (await c.services.principals.issueCredential(rob, "agent:zed")).token;

    // A stranger, a retired or unknown recipient, and the same owner are refused.
    assert.equal((await call(zed, "handoff.prepare", { taskId: task, to: { kind: "agent", id: b }, reason: "x" }, "h0")).error.code, "forbidden");
    assert.equal((await call(boot.token, "handoff.prepare", { taskId: task, to: { kind: "agent", id: "agt-zzzzzzzzzzzzzzzzzzzz" }, reason: "x" }, "h1")).error.code, "invalid_command");
    assert.equal((await call(boot.token, "handoff.prepare", { taskId: task, to: { kind: "agent", id: a }, reason: "x" }, "h2")).error.code, "invalid_command");

    const prepared = await call(boot.token, "handoff.prepare", { taskId: task, to: { kind: "agent", id: b }, reason: "A is going on leave" }, "h3");
    assert.ok(prepared.ok, JSON.stringify(prepared));
    const item = prepared.result.item;
    assert.equal(item.phase, "ready");
    assert.match(item.package.sections.brief, /weed the beds/);
    assert.match(item.package.sections.acceptanceCriteria, /photos attached/);
    assert.deepEqual(item.package.missing, ["unfinishedWork", "nextAction"], "what the controller cannot supply is reported, not invented");
    assert.equal((await call(boot.token, "handoff.complete", { handoffId: item.id }, "h4")).error.code, "invalid_command");
    assert.equal((await call(zed, "handoff.get", { handoffId: item.id })).error.code, "not_found");
    const done = await call(boot.token, "handoff.complete", { handoffId: item.id, acceptGaps: true }, "h5");
    assert.equal(done.result.item.phase, "transferred", JSON.stringify(done));
    assert.deepEqual(done.result.item.acceptedGaps.missing, ["unfinishedWork", "nextAction"]);
    const owner = (await call(boot.token, "assignment.get", { taskId: task })).result.item;
    assert.equal(owner.owner.id, b);
    assert.equal((await call(boot.token, "handoff.sweep", {}, "sw")).ok, true);
    assert.equal((await call(zed, "handoff.sweep", {}, "sw2")).error.code, "forbidden");
  } finally { await c.close(); rmSync(d, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }); }
});
