import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { AdmissionService } from "../admission/service.js";
import { ManualTimer } from "../dispatch/testing/timer.js";
import { PI, workGrants } from "../dispatch/testing/world.js";
import type { EnvironmentFacts, FilesystemDetector } from "../environment/index.js";
import { RemoteAttempt, RemoteWorkerClient } from "../remote/index.js";
import { startController } from "./index.js";

const ext4: FilesystemDetector = async () => ({ type: "ext4", network: false });
const supported: EnvironmentFacts = { platform: "linux", arch: "x64", osRelease: "6.8.0-generic", nodeVersion: "22.19.0" };
const CAPS = { os: "linux", arch: "x64", harnesses: [{ name: "pi", version: "1.3.0" }], isolation: ["bubblewrap"], tools: [], workspaces: [] };
const AGENT = "agt-abcdefghijklmnopqrst";
const policy: { dataHosts: string[] } = { dataHosts: ["host:r1", "host:r2"] };

const open = (d: string) => startController({
  storage: { kind: "sqlite", path: join(d, "c.sqlite") }, argv: [], env: {}, print: () => undefined, facts: supported, filesystem: ext4, features: [], harnesses: [PI],
  dispatch: {
    timer: new ManualTimer(), manual: true,
    route: async () => ({ route: "localp/small", harness: "pi", role: "worker", request: { contextTokens: 1000, needs: [], data: "local-only", paidAuthorized: false } }),
    remote: {
      blobDirectory: join(d, "blobs"), placementPolicy: async () => policy,
      hosts: ["r1", "r2"].map((n) => ({ hostId: `host:${n}`, window: () => 131_072, checkpointWaitMs: 300, pollMs: 20, resources: { cpus: 1, memoryMb: 1024 }, requirements: () => ({ data: "local-only" as const, harness: "pi" }) })),
    },
  },
});

test("a restarted controller knows its hosts' platforms before any of them connects, and a revoked host leaves the index (card H07b)", async () => {
  const d = mkdtempSync(join(tmpdir(), "nn-recheck-"));
  policy.dataHosts = ["host:r1", "host:r2"];
  let c = await open(d);
  try {
    const boot = await c.services.principals.bootstrapOwner({ name: "rob" });
    const rob = await c.services.principals.authenticate(boot.token);
    for (const n of ["r1", "r2"]) {
      await c.services.principals.enroll(rob, { commandId: `e-${n}`, kind: "host", name: n, grants: [] });
      const token = (await c.services.principals.issueCredential(rob, `host:${n}`)).token;
      const client = new RemoteWorkerClient({ url: c.dispatch!.workerUrl!, token, workerVersion: "worker-9.1.0" });
      await client.connect(CAPS as never);
      await client.heartbeat(1);
    }
    assert.deepEqual(c.dispatch!.remote!.platformIndex(rob), { "linux/x64": ["host:r1", "host:r2"] });
    await c.close();
    // The controller starts again: nobody has connected or polled yet, and the index already holds both.
    c = await open(d);
    const again = await c.services.principals.authenticate(boot.token);
    assert.deepEqual(c.dispatch!.remote!.platformIndex(again), { "linux/x64": ["host:r1", "host:r2"] });
    const found = await c.storage.getAggregate({ kind: "principal", id: "host:r2" });
    await c.services.principals.disable(again, { commandId: "dis-r2", principalId: "host:r2", expectedRevision: found!.revision });
    const q = { taskId: "task-aaaaaaaaaaaaaaaaaaaa", projectId: "proj-aaaaaaaaaaaaaaaaaaaa", agentId: "agent:ann", requirements: { data: "local-only" as const, harness: "pi" } };
    const first = await c.dispatch!.remote!.candidates(again, q);
    assert.match(first.refused.find((r) => r.hostId === "host:r2")?.reasons.join(";") ?? "", /host:r2 is revoked/);
    assert.deepEqual(c.dispatch!.remote!.platformIndex(again), { "linux/x64": ["host:r1"] });
    // A third start leaves the revoked host out from the start.
    await c.close();
    c = await open(d);
    assert.deepEqual(c.dispatch!.remote!.platformIndex(await c.services.principals.authenticate(boot.token)), { "linux/x64": ["host:r1"] });
  } finally { await c.close(); rmSync(d, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }); }
});

test("an offer the policy refused after it was made is not delivered over the wire; the attempt is ended with the reasons and the task starts again on the host the policy now lists (card H07b)", async () => {
  const d = mkdtempSync(join(tmpdir(), "nn-recheck-"));
  policy.dataHosts = ["host:r1", "host:r2"];
  const c = await open(d);
  try {
    const boot = await c.services.principals.bootstrapOwner({ name: "rob" });
    const rob = await c.services.principals.authenticate(boot.token);
    const project = (await c.services.projects.createProject({ commandId: "p1", actor: rob.id, name: "Garden" })).id;
    await c.services.principals.enroll(rob, { commandId: "e-ann", kind: "agent", name: AGENT, grants: workGrants(project, ["read-file"]) });
    const clients = new Map<string, RemoteWorkerClient>();
    for (const n of ["r1", "r2"]) {
      await c.services.principals.enroll(rob, { commandId: `e-${n}`, kind: "host", name: n, grants: [] });
      const token = (await c.services.principals.issueCredential(rob, `host:${n}`)).token;
      await AdmissionService.withEpoch(c.storage, c.epoch).setCapacity({ commandId: `cap-${n}`, actor: rob.id, host: `host:${n}`, capacity: { cpus: 8, memoryMb: 16_384 } });
      const client = new RemoteWorkerClient({ url: c.dispatch!.workerUrl!, token, workerVersion: "worker-9.1.0" });
      await client.connect(CAPS as never);
      await client.heartbeat(1);
      clients.set(`host:${n}`, client);
    }
    const taskId = (await c.services.projects.createTask({ commandId: "t1", actor: rob.id, projectId: project, title: "Order seeds" })).id;
    await c.services.projects.transitionTask({ commandId: "r1", actor: rob.id, taskId, expectedRevision: 1, to: "ready" });
    await c.services.assignments.assignTask({ commandId: "as1", actor: rob.id, taskId, owner: { kind: "agent", id: AGENT } });
    const a = (await c.services.assignments.getAssignment(taskId))!;
    const first = (await c.services.assignments.admitAttempt({ commandId: "ad1", actor: "inbox", taskId, expectedRevision: a.revision, generation: a.generation, owner: { kind: "agent", id: AGENT }, harness: "pi" })).id;
    assert.deepEqual((await c.dispatch!.dispatcher.tick()).started, [first]);
    assert.equal((await c.dispatch!.remote!.placement(rob, first))!.hostId, "host:r1");
    // The owner takes r1 off the list before r1 reads its offer.
    policy.dataHosts = ["host:r2"];
    assert.deepEqual(await clients.get("host:r1")!.offers(), [], "nothing reaches the host");
    const placement = (await c.dispatch!.remote!.placement(rob, first))!;
    assert.equal(placement.state, "ended");
    assert.match(placement.history.at(-1)!.reason, /withdrawn before it was delivered, host:r1 would now refuse it/);
    assert.equal(c.dispatch!.remote!.pollStats(rob).withdrawn, 1);
    for (let i = 0; i < 100 && (await c.dispatch!.dispatcher.get(rob, first))?.state === "running"; i++) await new Promise((r) => setTimeout(r, 20));
    const rec = (await c.dispatch!.dispatcher.get(rob, first))!;
    assert.match(rec.outcome?.summary ?? "", /withdrawn before it was delivered/);
    // The task is put back: it has a new attempt. The offer was never taken up, so r1's claim on the agent's native store pins nothing and the new attempt starts on r2, the host the policy lists.
    let started: string | undefined;
    for (let i = 0; i < 150 && started === undefined; i++) {
      if (i > 0) await new Promise((r) => setTimeout(r, 20));
      started = (await c.dispatch!.dispatcher.tick()).started.find((id) => id !== first);
    }
    assert.ok(started !== undefined, "the readmitted attempt starts");
    assert.equal((await c.dispatch!.remote!.placement(rob, started))!.hostId, "host:r2");
    assert.equal((await clients.get("host:r2")!.offers()).length, 1, "and this time the host is delivered the offer");
    assert.deepEqual(await clients.get("host:r1")!.offers(), [], "r1 is never offered it");
    // r2 takes it up: the store is real there. Another attempt of the agent is now tied to r2 even though r1 is listed again.
    const taken = (await c.dispatch!.remote!.placement(rob, started))!;
    await new RemoteAttempt(clients.get("host:r2")!, started, taken.placement).accept();
    policy.dataHosts = ["host:r1", "host:r2"];
    assert.deepEqual(await c.dispatch!.remote!.storeOwner(rob, taken.agentId, "att-zzzzzzzzzzzzzzzzzzzz"), { hostId: "host:r2", busy: true });
  } finally { await c.close(); rmSync(d, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }); }
});
