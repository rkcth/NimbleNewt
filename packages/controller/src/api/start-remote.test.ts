import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { AdmissionService } from "../admission/service.js";
import { ManualTimer } from "../dispatch/testing/timer.js";
import { PI } from "../dispatch/testing/world.js";
import type { EnvironmentFacts, FilesystemDetector } from "../environment/index.js";
import { RemoteWorkerClient } from "../remote/index.js";
import { startController } from "./index.js";

const ext4: FilesystemDetector = async () => ({ type: "ext4", network: false });
const supported: EnvironmentFacts = { platform: "linux", arch: "x64", osRelease: "6.8.0-generic", nodeVersion: "22.19.0" };
const CAPS = { os: "linux", arch: "x64", harnesses: [{ name: "pi", version: "1.3.0" }], isolation: ["bubblewrap"], tools: [], workspaces: [] };

test("the composed controller places an attempt on a remote host over its own transport; the worker fetches the order, cannot admit work, an incompatible protocol is refused, and the native store has one owner host (card H02)", async () => {
  const d = mkdtempSync(join(tmpdir(), "nn-remote-"));
  const c = await startController({
    storage: { kind: "sqlite", path: join(d, "c.sqlite") }, argv: [], env: {}, print: () => undefined, facts: supported, filesystem: ext4, features: [], harnesses: [PI],
    dispatch: {
      timer: new ManualTimer(), manual: true,
      route: async () => ({ route: "localp/small", harness: "pi", role: "worker", request: { contextTokens: 1000, needs: [], data: "cloud-allowed", paidAuthorized: false } }),
      remote: { blobDirectory: join(d, "blobs"), hosts: [{ hostId: "host:r1", resources: { cpus: 1, memoryMb: 1024 }, requirements: () => ({ data: "cloud-allowed", harness: "pi" }) }] },
    },
  });
  try {
    assert.ok(c.dispatch?.workerUrl !== undefined, c.dispatchProblem);
    const boot = await c.services.principals.bootstrapOwner({ name: "rob" });
    const rob = await c.services.principals.authenticate(boot.token);
    const project = (await c.services.projects.createProject({ commandId: "p1", actor: rob.id, name: "Garden" })).id;
    await c.services.principals.enroll(rob, { commandId: "e-r1", kind: "host", name: "r1", grants: [] });
    const hostToken = (await c.services.principals.issueCredential(rob, "host:r1")).token;
    await AdmissionService.withEpoch(c.storage, c.epoch).setCapacity({ commandId: "cap", actor: rob.id, host: "host:r1", capacity: { cpus: 8, memoryMb: 16_384 } });
    await c.services.principals.enroll(rob, { commandId: "e-ann", kind: "agent", name: "agt-abcdefghijklmnopqrst", grants: [{ action: "attempt.work", project }, { action: "task.read", project }, { action: "effect.perform", project }, { action: "review.request", project }] });
    const task = (await c.services.projects.createTask({ commandId: "t1", actor: rob.id, projectId: project, title: "Order seeds" })).id;
    await c.services.projects.transitionTask({ commandId: "r1", actor: rob.id, taskId: task, expectedRevision: 1, to: "ready" });
    await c.services.assignments.assignTask({ commandId: "as1", actor: rob.id, taskId: task, owner: { kind: "agent", id: "agt-abcdefghijklmnopqrst" } });
    const a = (await c.services.assignments.getAssignment(task))!;
    const attemptId = (await c.services.assignments.admitAttempt({ commandId: "ad1", actor: "inbox", taskId: task, expectedRevision: a.revision, generation: a.generation, owner: { kind: "agent", id: "agt-abcdefghijklmnopqrst" }, harness: "pi" })).id;

    // A worker whose protocol this controller does not speak is refused visibly.
    const old = new RemoteWorkerClient({ url: c.dispatch!.workerUrl!, token: hostToken, workerVersion: "w-0", protocol: { min: 99, max: 99 } } as never);
    await assert.rejects(() => old.connect(CAPS as never), (e: { code?: string; message?: string }) => /protocol|version/i.test(`${e.code} ${e.message}`));
    // A compatible worker connects, is offered the attempt, and receives the controller's own order.
    const client = new RemoteWorkerClient({ url: c.dispatch!.workerUrl!, token: hostToken, workerVersion: "worker-9.1.0" });
    await client.connect(CAPS as never);
    await client.heartbeat(1);
    const report = await c.dispatch!.dispatcher.tick();
    assert.ok(report.started.includes(attemptId), JSON.stringify({ s: report.skipped, f: report.failures, w: report.waiting, b: report.blocked, scanned: report.scanned, complete: report.complete }));
    const offer = (await client.offers()).find((o) => o.order.attemptId === attemptId);
    assert.ok(offer, "the attempt was offered to the remote host");
    assert.equal(offer!.order.taskId, task);
    await client.attempt(attemptId, offer!.placement).accept();
    // The worker's credential is a host credential: it cannot admit work or call the state API as the owner.
    const api = await c.api.handle(hostToken, { v: 1, op: "project.create", commandId: "x", args: { name: "Evil" } } as never) as { ok: boolean };
    assert.equal(api.ok, false, "a remote worker cannot create projects");
    // The native store of an agent has one exclusive owner host while it works there.
    const owner = await c.dispatch!.hostOfAgent("agent:agt-abcdefghijklmnopqrst");
    assert.equal(owner, "host:r1");
  } finally { await c.close(); rmSync(d, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }); }
});
