import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { WorkerHost } from "../dispatch/index.js";
import { ManualTimer } from "../dispatch/testing/timer.js";
import { PI } from "../dispatch/testing/world.js";
import type { EnvironmentFacts, FilesystemDetector } from "../environment/index.js";
import type { WorkspaceCall } from "../workspace-ops/index.js";
import { startController } from "./index.js";

const ext4: FilesystemDetector = async () => ({ type: "ext4", network: false });
const supported: EnvironmentFacts = { platform: "linux", arch: "x64", osRelease: "6.8.0-generic", nodeVersion: "22.19.0" };

test("integration, refresh and quarantine are requested through the state API, reach the host that holds the checkout, and are refused to anyone without workspace.manage (cards H12l, H12d)", async () => {
  const d = mkdtempSync(join(tmpdir(), "nn-workspace-"));
  const calls: WorkspaceCall[] = [];
  const host: WorkerHost = {
    hostId: "host:w1", resources: { cpus: 1, memoryMb: 512 }, start: async () => { throw new Error("no attempt is started here"); },
    workspace: { run: async (call) => { calls.push(call); return call.operation === "quarantine" ? { ok: false, reason: "nothing to quarantine" } : { ok: true, summary: `${call.operation} done`, detail: { by: call.requestId.slice(0, 4) } }; } },
  };
  const c = await startController({ storage: { kind: "sqlite", path: join(d, "c.sqlite") }, argv: [], env: {}, print: () => undefined, facts: supported, filesystem: ext4, features: [], harnesses: [PI], dispatch: { timer: new ManualTimer(), intervalMs: 1000, workers: [host] } });
  try {
    const boot = await c.services.principals.bootstrapOwner({ name: "rob" });
    const rob = await c.services.principals.authenticate(boot.token);
    const project = (await c.services.projects.createProject({ commandId: "p1", actor: rob.id, name: "Garden" })).id;
    const task = (await c.services.projects.createTask({ commandId: "t1", actor: rob.id, projectId: project, title: "Dig" })).id;
    const tok = async (name: string, grants: { action: string; project: string }[]) => { await c.services.principals.enroll(rob, { commandId: `e-${name}`, kind: "agent", name, grants }); return (await c.services.principals.issueCredential(rob, `agent:${name}`)).token; };
    const boss = await tok("boss", [{ action: "workspace.manage", project }]);
    const plain = await tok("plain", [{ action: "task.read", project }]);
    const call = (token: string, op: string, args: Record<string, unknown>, commandId?: string) => c.api.handle(token, { v: 1, op, ...(commandId === undefined ? {} : { commandId }), args } as never) as Promise<{ ok: boolean; result?: any; error?: { code: string } }>;

    const done = await call(boss, "workspace.request", { operation: "refresh", taskId: task, reason: "the base moved" }, "w1");
    assert.ok(done.ok, JSON.stringify(done));
    assert.deepEqual([done.result.state, done.result.summary, done.result.replayed], ["done", "refresh done", false]);
    assert.deepEqual(calls.map((x) => [x.operation, x.taskId, x.projectId]), [["refresh", task, project]]);
    assert.equal((await call(boss, "workspace.request", { operation: "refresh", taskId: task, reason: "the base moved" }, "w1")).result.replayed, true);
    assert.equal(calls.length, 1, "a repeat asks the host once");
    assert.equal((await call(boss, "workspace.request", { operation: "quarantine", taskId: task, reason: "odd file" }, "w2")).result.state, "refused", "the host's refusal is a typed answer");
    assert.equal((await call(boss, "workspace.get", { requestId: done.result.id })).result.item.summary, "refresh done");
    // Rights: no grant, no answer; a task credential never; an unknown operation is invalid.
    assert.equal((await call(plain, "workspace.request", { operation: "refresh", taskId: task, reason: "x" }, "w3")).error?.code, "not_found");
    assert.equal((await call(plain, "workspace.get", { requestId: done.result.id })).error?.code, "not_found");
    assert.equal((await call(boss, "workspace.request", { operation: "release", taskId: task, reason: "x" }, "w4")).error?.code, "invalid_command");
    assert.equal(calls.length, 2, "only the two allowed requests reached the host");
    const grant = await c.api.handle(boot.token, { v: 1, op: "workspace.request", commandId: "w5", args: { operation: "integration", taskId: task, reason: "ready" } } as never) as { ok: boolean; result?: any };
    assert.equal(grant.result.state, "done", "the owner may always ask");
    // The dispatcher's tick runs the recovery of requests a stopped controller left open; with none open it resolves nothing.
    const tick = await c.dispatch!.dispatcher.tick();
    assert.ok(tick.loops.some((l) => l.name === "workspace.recover" && l.ok), "the recovery loop ran");
  } finally { await c.close(); rmSync(d, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }); }
});

test("without a dispatcher there is no host to ask: the request is recorded and refused (cards H12l, H12d)", async () => {
  const d = mkdtempSync(join(tmpdir(), "nn-workspace-"));
  const c = await startController({ storage: { kind: "sqlite", path: join(d, "c.sqlite") }, argv: [], env: {}, print: () => undefined, facts: supported, filesystem: ext4, features: [] });
  try {
    const boot = await c.services.principals.bootstrapOwner({ name: "rob" });
    const rob = await c.services.principals.authenticate(boot.token);
    const project = (await c.services.projects.createProject({ commandId: "p1", actor: rob.id, name: "Garden" })).id;
    const task = (await c.services.projects.createTask({ commandId: "t1", actor: rob.id, projectId: project, title: "Dig" })).id;
    const r = await c.api.handle(boot.token, { v: 1, op: "workspace.request", commandId: "w1", args: { operation: "refresh", taskId: task, reason: "moved" } } as never) as { ok: boolean; result?: any };
    assert.deepEqual([r.result.state, /no host/.test(r.result.summary)], ["refused", true]);
  } finally { await c.close(); rmSync(d, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }); }
});
