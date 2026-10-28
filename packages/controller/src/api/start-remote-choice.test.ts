import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { AdmissionService } from "../admission/service.js";
import { ManualTimer } from "../dispatch/testing/timer.js";
import { PI, workGrants } from "../dispatch/testing/world.js";
import type { EnvironmentFacts, FilesystemDetector } from "../environment/index.js";
import { RemoteWorkerClient } from "../remote/index.js";
import { startController } from "./index.js";

const ext4: FilesystemDetector = async () => ({ type: "ext4", network: false });
const supported: EnvironmentFacts = { platform: "linux", arch: "x64", osRelease: "6.8.0-generic", nodeVersion: "22.19.0" };
const CAPS = { os: "linux", arch: "x64", harnesses: [{ name: "pi", version: "1.3.0" }], isolation: ["bubblewrap"], tools: [], workspaces: [] };
const AGENT = "agt-abcdefghijklmnopqrst";
const OTHER = "agt-bbbbbbbbbbbbbbbbbbbb";

test("the dispatcher passes over a host that would refuse the attempt and starts it on the next eligible one, saying why in the plan; when every host refuses it waits with the reasons and the owner is told at last (card H07e)", async () => {
  const d = mkdtempSync(join(tmpdir(), "nn-choice-"));
  const policy: { dataHosts: string[] } = { dataHosts: ["host:r2"] };
  const c = await startController({
    storage: { kind: "sqlite", path: join(d, "c.sqlite") }, argv: [], env: {}, print: () => undefined, facts: supported, filesystem: ext4, features: [], harnesses: [PI],
    dispatch: {
      timer: new ManualTimer(), manual: true,
      route: async () => ({ route: "localp/small", harness: "pi", role: "worker", request: { contextTokens: 1000, needs: [], data: "local-only", paidAuthorized: false } }),
      remote: {
        blobDirectory: join(d, "blobs"), placementPolicy: async () => policy,
        hosts: ["r1", "r2"].map((n) => ({ hostId: `host:${n}`, checkpointWaitMs: 300, pollMs: 20, resources: { cpus: 1, memoryMb: 1024 }, requirements: () => ({ data: "local-only" as const, harness: "pi" }) })),
      },
    },
  });
  try {
    assert.ok(c.dispatch?.workerUrl !== undefined, c.dispatchProblem);
    const boot = await c.services.principals.bootstrapOwner({ name: "rob" });
    const rob = await c.services.principals.authenticate(boot.token);
    const project = (await c.services.projects.createProject({ commandId: "p1", actor: rob.id, name: "Garden" })).id;
    await c.services.principals.enroll(rob, { commandId: "e-ann", kind: "agent", name: AGENT, grants: workGrants(project, ["read-file"]) });
    await c.services.principals.enroll(rob, { commandId: "e-bob", kind: "agent", name: OTHER, grants: workGrants(project, ["read-file"]) });
    const clients = new Map<string, RemoteWorkerClient>();
    for (const n of ["r1", "r2"]) {
      await c.services.principals.enroll(rob, { commandId: `e-${n}`, kind: "host", name: n, grants: [] });
      const token = (await c.services.principals.issueCredential(rob, `host:${n}`)).token;
      await AdmissionService.withEpoch(c.storage, c.epoch).setCapacity({ commandId: `cap-${n}`, actor: rob.id, host: `host:${n}`, capacity: { cpus: 8, memoryMb: 16_384 } });
      const client = new RemoteWorkerClient({ url: c.dispatch.workerUrl, token, workerVersion: "worker-9.1.0" });
      await client.connect(CAPS as never);
      await client.heartbeat(1);
      clients.set(`host:${n}`, client);
    }
    let n = 0;
    const attempt = async (agent = AGENT): Promise<string> => {
      n++;
      const taskId = (await c.services.projects.createTask({ commandId: `t${n}`, actor: rob.id, projectId: project, title: `Order seeds ${n}` })).id;
      await c.services.projects.transitionTask({ commandId: `r${n}`, actor: rob.id, taskId, expectedRevision: 1, to: "ready" });
      await c.services.assignments.assignTask({ commandId: `as${n}`, actor: rob.id, taskId, owner: { kind: "agent", id: agent } });
      const a = (await c.services.assignments.getAssignment(taskId))!;
      return (await c.services.assignments.admitAttempt({ commandId: `ad${n}`, actor: "inbox", taskId, expectedRevision: a.revision, generation: a.generation, owner: { kind: "agent", id: agent }, harness: "pi" })).id;
    };
    // r1 comes first in the dispatcher's order but the policy lists only r2 for local-only data: r2 gets it.
    const first = await attempt();
    const report = await c.dispatch!.dispatcher.tick();
    assert.deepEqual(report.started, [first], JSON.stringify({ s: report.skipped, f: report.failures }));
    assert.equal((await c.dispatch!.remote!.placement(rob, first))!.hostId, "host:r2");
    assert.equal((await clients.get("host:r1")!.offers()).length, 0, "the refusing host was offered nothing");
    assert.equal((await clients.get("host:r2")!.offers()).length, 1);
    // No host listed at all: the next attempt waits in the plan with every host's reasons, and is blocked for the owner after a few ticks.
    policy.dataHosts = [];
    const second = await attempt(OTHER);
    const skipped = await c.dispatch!.dispatcher.tick();
    assert.deepEqual(skipped.started, []);
    const entry = skipped.skipped.find((s) => s.attemptId === second);
    assert.ok(entry !== undefined, JSON.stringify(skipped));
    assert.match(entry.reason, /does not list host:r1[\s\S]*does not list host:r2/, entry.reason);
    assert.equal(await c.dispatch!.remote!.placement(rob, second), undefined, "nothing was placed; it waits, it did not fail");
    let blocked = false;
    for (let i = 0; i < 6 && !blocked; i++) blocked = (await c.dispatch!.dispatcher.tick()).blocked.some((b) => b.attemptId === second);
    assert.ok(blocked, "after a few ticks the owner is told");
    // The owner lists a host: the same attempt now starts there.
    policy.dataHosts = ["host:r1"];
    const later = await c.dispatch!.dispatcher.tick();
    assert.deepEqual(later.started, [second], JSON.stringify({ s: later.skipped, b: later.blocked }));
    assert.equal((await c.dispatch!.remote!.placement(rob, second))!.hostId, "host:r1");
  } finally { await c.close(); rmSync(d, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }); }
});
