import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { AdmissionService } from "../admission/service.js";
import { ManualTimer } from "../dispatch/testing/timer.js";
import { PI, workGrants } from "../dispatch/testing/world.js";
import type { EnvironmentFacts, FilesystemDetector } from "../environment/index.js";
import { request as httpRequest } from "node:http";
import { RemoteAttempt, RemoteWorkerClient } from "../remote/index.js";
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
        hosts: ["r1", "r2"].map((n) => ({ hostId: `host:${n}`, window: () => 131_072, checkpointWaitMs: 300, pollMs: 20, resources: { cpus: 1, memoryMb: 1024 }, requirements: () => ({ data: "local-only" as const, harness: "pi" }) })),
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

test("a host that is only not connected yet is waited for: the attempt is skipped with the reason and the owner is never told, however many ticks pass (card H07e)", async () => {
  const d = mkdtempSync(join(tmpdir(), "nn-choice-"));
  const c = await startController({
    storage: { kind: "sqlite", path: join(d, "c.sqlite") }, argv: [], env: {}, print: () => undefined, facts: supported, filesystem: ext4, features: [], harnesses: [PI],
    dispatch: {
      timer: new ManualTimer(), manual: true,
      route: async () => ({ route: "localp/small", harness: "pi", role: "worker", request: { contextTokens: 1000, needs: [], data: "cloud-allowed", paidAuthorized: false } }),
      remote: { blobDirectory: join(d, "blobs"), hosts: [{ hostId: "host:r1", window: () => 131_072, checkpointWaitMs: 300, pollMs: 20, resources: { cpus: 1, memoryMb: 1024 }, requirements: () => ({ data: "cloud-allowed" as const, harness: "pi" }) }] },
    },
  });
  try {
    const boot = await c.services.principals.bootstrapOwner({ name: "rob" });
    const rob = await c.services.principals.authenticate(boot.token);
    const project = (await c.services.projects.createProject({ commandId: "p1", actor: rob.id, name: "Garden" })).id;
    await c.services.principals.enroll(rob, { commandId: "e-ann", kind: "agent", name: AGENT, grants: workGrants(project, ["read-file"]) });
    await c.services.principals.enroll(rob, { commandId: "e-r1", kind: "host", name: "r1", grants: [] });
    const token = (await c.services.principals.issueCredential(rob, "host:r1")).token;
    await AdmissionService.withEpoch(c.storage, c.epoch).setCapacity({ commandId: "cap", actor: rob.id, host: "host:r1", capacity: { cpus: 8, memoryMb: 16_384 } });
    const taskId = (await c.services.projects.createTask({ commandId: "t1", actor: rob.id, projectId: project, title: "Order seeds" })).id;
    await c.services.projects.transitionTask({ commandId: "r1", actor: rob.id, taskId, expectedRevision: 1, to: "ready" });
    await c.services.assignments.assignTask({ commandId: "as1", actor: rob.id, taskId, owner: { kind: "agent", id: AGENT } });
    const a = (await c.services.assignments.getAssignment(taskId))!;
    const attemptId = (await c.services.assignments.admitAttempt({ commandId: "ad1", actor: "inbox", taskId, expectedRevision: a.revision, generation: a.generation, owner: { kind: "agent", id: AGENT }, harness: "pi" })).id;
    const client = new RemoteWorkerClient({ url: c.dispatch!.workerUrl!, token, workerVersion: "worker-9.1.0" });
    // The host is enrolled but has not connected: a skip with the reason for many ticks, never a blocker.
    for (let i = 0; i < 8; i++) {
      const r = await c.dispatch!.dispatcher.tick();
      assert.deepEqual([r.started, r.blocked], [[], []], `tick ${i}`);
      assert.match(r.skipped.find((x) => x.attemptId === attemptId)?.reason ?? "", /not connected|heard from|not announced/);
    }
    await client.connect(CAPS as never); await client.heartbeat(1);
    const fresh = await c.dispatch!.dispatcher.tick();
    assert.deepEqual(fresh.started, [attemptId], "connected: it starts");
  } finally { await c.close(); rmSync(d, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }); }
});

test("a host that refuses the attempt when it is placed (the policy changed after it was chosen) offers nothing; the attempt waits, starts on the next host on the next tick, and its record says why the first host was passed over (card H07b)", async () => {
  const d = mkdtempSync(join(tmpdir(), "nn-choice-"));
  // Both hosts are listed, except that the placement on r1 of the first attempt is refused once: the policy is read again at the place, after the dispatcher chose r1.
  let refuseOnce = true;
  let who: { id: string } | undefined;
  let svc: Awaited<ReturnType<typeof startController>> | undefined;
  const c = await startController({
    storage: { kind: "sqlite", path: join(d, "c.sqlite") }, argv: [], env: {}, print: () => undefined, facts: supported, filesystem: ext4, features: [], harnesses: [PI],
    dispatch: {
      timer: new ManualTimer(), manual: true,
      route: async () => ({ route: "localp/small", harness: "pi", role: "worker", request: { contextTokens: 1000, needs: [], data: "local-only", paidAuthorized: false } }),
      remote: {
        blobDirectory: join(d, "blobs"),
        placementPolicy: async (q) => {
          const rec = q.attemptId === undefined || who === undefined ? undefined : await svc!.dispatch!.dispatcher.get(who as never, q.attemptId);
          if (refuseOnce && rec?.state === "running" && rec.hostId === "host:r1") { refuseOnce = false; return { dataHosts: ["host:r2"] }; }
          return { dataHosts: ["host:r1", "host:r2"] };
        },
        hosts: ["r1", "r2"].map((n) => ({ hostId: `host:${n}`, window: () => 131_072, checkpointWaitMs: 300, pollMs: 20, resources: { cpus: 1, memoryMb: 1024 }, requirements: () => ({ data: "local-only" as const, harness: "pi" }) })),
      },
    },
  });
  svc = c;
  try {
    assert.ok(c.dispatch?.workerUrl !== undefined, c.dispatchProblem);
    const boot = await c.services.principals.bootstrapOwner({ name: "rob" });
    const rob = await c.services.principals.authenticate(boot.token);
    who = rob;
    const project = (await c.services.projects.createProject({ commandId: "p1", actor: rob.id, name: "Garden" })).id;
    await c.services.principals.enroll(rob, { commandId: "e-ann", kind: "agent", name: AGENT, grants: workGrants(project, ["read-file"]) });
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
    const taskId = (await c.services.projects.createTask({ commandId: "t1", actor: rob.id, projectId: project, title: "Order seeds" })).id;
    await c.services.projects.transitionTask({ commandId: "r1", actor: rob.id, taskId, expectedRevision: 1, to: "ready" });
    await c.services.assignments.assignTask({ commandId: "as1", actor: rob.id, taskId, owner: { kind: "agent", id: AGENT } });
    const a = (await c.services.assignments.getAssignment(taskId))!;
    const attemptId = (await c.services.assignments.admitAttempt({ commandId: "ad1", actor: "inbox", taskId, expectedRevision: a.revision, generation: a.generation, owner: { kind: "agent", id: AGENT }, harness: "pi" })).id;
    // r1 comes first and says beforehand it would take it, then refuses at the place: nothing is offered, the attempt waits (it did not fail), and the plan says so.
    const first = await c.dispatch!.dispatcher.tick();
    assert.deepEqual(first.started, [], JSON.stringify(first));
    assert.equal(refuseOnce, false, "the place on r1 was asked and refused");
    assert.match(first.skipped.find((s) => s.attemptId === attemptId)?.reason ?? "", /^host:r1 cannot take attempt .*does not list host:r1.*nothing was given to it, and the attempt is tried on another host/);
    assert.equal(await c.dispatch!.remote!.placement(rob, attemptId), undefined, "nothing was placed");
    assert.equal((await clients.get("host:r1")!.offers()).length, 0, "the refusing host was offered nothing");
    assert.equal((await c.services.assignments.getAttempt(attemptId))!.state, "active");
    // The next tick: r1 would take it now, but it refused this attempt once, so r2 gets it.
    const second = await c.dispatch!.dispatcher.tick();
    assert.deepEqual(second.started, [attemptId], JSON.stringify(second));
    assert.equal((await c.dispatch!.remote!.placement(rob, attemptId))!.hostId, "host:r2");
    assert.equal((await clients.get("host:r1")!.offers()).length, 0);
    assert.equal((await clients.get("host:r2")!.offers()).length, 1);
    const rec = (await c.dispatch!.dispatcher.get(rob, attemptId))!;
    assert.deepEqual([rec.hostId, rec.hostChoice?.passedOver.map((p) => p.hostId), rec.startRefusals?.map((r) => [r.hostId, r.lasting])], ["host:r2", ["host:r1"], [["host:r1", true]]]);
    assert.match(rec.hostChoice!.passedOver[0]!.reason, /refused this attempt at its start .*does not list host:r1/);
  } finally { await c.close(); rmSync(d, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }); }
});

const AGENTS = ["agt-cccccccccccccccccccc", "agt-dddddddddddddddddddd", "agt-eeeeeeeeeeeeeeeeeeee", "agt-ffffffffffffffffffff"];

async function twoHosts(d: string) {
  const c = await startController({
    storage: { kind: "sqlite", path: join(d, "c.sqlite") }, argv: [], env: {}, print: () => undefined, facts: supported, filesystem: ext4, features: [], harnesses: [PI],
    dispatch: {
      timer: new ManualTimer(), manual: true,
      route: async () => ({ route: "localp/small", harness: "pi", role: "worker", request: { contextTokens: 1000, needs: [], data: "cloud-allowed", paidAuthorized: false } }),
      remote: { blobDirectory: join(d, "blobs"), hosts: ["r1", "r2"].map((n) => ({ hostId: `host:${n}`, window: () => 131_072, checkpointWaitMs: 300, pollMs: 20, resources: { cpus: 1, memoryMb: 1024 }, requirements: () => ({ data: "cloud-allowed" as const, harness: "pi" }) })) },
    },
  });
  const boot = await c.services.principals.bootstrapOwner({ name: "rob" });
  const rob = await c.services.principals.authenticate(boot.token);
  const project = (await c.services.projects.createProject({ commandId: "p1", actor: rob.id, name: "Garden" })).id;
  for (const a of AGENTS) await c.services.principals.enroll(rob, { commandId: `e-${a}`, kind: "agent", name: a, grants: workGrants(project, ["read-file"]) });
  const clients = new Map<string, RemoteWorkerClient>();
  const tokens = new Map<string, string>();
  for (const n of ["r1", "r2"]) {
    await c.services.principals.enroll(rob, { commandId: `e-${n}`, kind: "host", name: n, grants: [] });
    const token = (await c.services.principals.issueCredential(rob, `host:${n}`)).token;
    await AdmissionService.withEpoch(c.storage, c.epoch).setCapacity({ commandId: `cap-${n}`, actor: rob.id, host: `host:${n}`, capacity: { cpus: 8, memoryMb: 16_384 } });
    const client = new RemoteWorkerClient({ url: c.dispatch!.workerUrl!, token, workerVersion: "worker-9.1.0" });
    await client.connect(CAPS as never);
    await client.heartbeat(1);
    clients.set(`host:${n}`, client); tokens.set(`host:${n}`, token);
  }
  let n = 0;
  const attempt = async (agent: string): Promise<string> => {
    n++;
    const taskId = (await c.services.projects.createTask({ commandId: `t${n}`, actor: rob.id, projectId: project, title: `Order seeds ${n}` })).id;
    await c.services.projects.transitionTask({ commandId: `r${n}`, actor: rob.id, taskId, expectedRevision: 1, to: "ready" });
    await c.services.assignments.assignTask({ commandId: `as${n}`, actor: rob.id, taskId, owner: { kind: "agent", id: agent } });
    const a = (await c.services.assignments.getAssignment(taskId))!;
    return (await c.services.assignments.admitAttempt({ commandId: `ad${n}`, actor: "inbox", taskId, expectedRevision: a.revision, generation: a.generation, owner: { kind: "agent", id: agent }, harness: "pi" })).id;
  };
  return { c, rob, clients, tokens, attempt };
}

test("attempts go to the host with fewer unaccepted offers, equal loads keep the configuration order, and a host that takes its offer up is less loaded again (card H07b)", async () => {
  const d = mkdtempSync(join(tmpdir(), "nn-choice-"));
  const { c, rob, clients, attempt } = await twoHosts(d);
  try {
    const where = async (id: string): Promise<string | undefined> => (await c.dispatch!.remote!.placement(rob, id))?.hostId;
    const a1 = await attempt(AGENTS[0]!);
    assert.deepEqual((await c.dispatch!.dispatcher.tick()).started, [a1]);
    assert.equal(await where(a1), "host:r1", "equal loads: the configuration order");
    const a2 = await attempt(AGENTS[1]!);
    assert.deepEqual((await c.dispatch!.dispatcher.tick()).started, [a2]);
    assert.equal(await where(a2), "host:r2", "r1 holds an offer, r2 none: r2 first although r1 is listed first");
    // r2 takes its offer up: it is the lighter one again (r1 still holds one), so the next attempt goes to r2 although r1 is listed first.
    const placed = await c.dispatch!.remote!.placement(rob, a2);
    await new RemoteAttempt(clients.get("host:r2")!, a2, placed!.placement).accept();
    assert.equal(c.dispatch!.remote!.offerLoad(rob, "host:r1"), 1);
    assert.equal(c.dispatch!.remote!.offerLoad(rob, "host:r2"), 0);
    const a3 = await attempt(AGENTS[2]!);
    const t3 = await c.dispatch!.dispatcher.tick();
    assert.deepEqual(t3.started, [a3], JSON.stringify({ s: t3.skipped, w: t3.waiting }));
    assert.equal(await where(a3), "host:r2");
    // One offer each now: the tie keeps the configuration order, and it does so every time.
    assert.equal(c.dispatch!.remote!.offerLoad(rob, "host:r2"), 1);
  } finally { await c.close(); rmSync(d, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }); }
});

test("a held offers poll ends when its client disconnects, and frees its place, with the real listener (card H07b)", async () => {
  const d = mkdtempSync(join(tmpdir(), "nn-choice-"));
  const { c, rob, clients, tokens } = await twoHosts(d);
  try {
    const remote = c.dispatch!.remote!;
    const session = clients.get("host:r1")!.session!;
    const url = new URL("/worker/session/offers?wait=20000", c.dispatch!.workerUrl!);
    const req = httpRequest(url, { method: "GET", headers: { authorization: `Bearer ${tokens.get("host:r1")}`, "x-newt-session": session.sessionId, "x-newt-protocol": String(session.protocol) } });
    req.on("error", () => undefined);
    req.end();
    for (let i = 0; i < 300 && remote.pollStats(rob).open !== 1; i++) await new Promise((r) => setTimeout(r, 20));
    assert.equal(remote.pollStats(rob).open, 1, "the poll is held");
    req.destroy();
    for (let i = 0; i < 300 && remote.pollStats(rob).open !== 0; i++) await new Promise((r) => setTimeout(r, 20));
    const stats = remote.pollStats(rob);
    assert.equal(stats.open, 0, "the held poll ended without waiting for the 20 s");
    assert.equal(stats.disconnected, 1);
    assert.equal(stats.timedOut, 0);
    // A normal poll that is answered is not counted as a disconnect.
    assert.deepEqual(await clients.get("host:r1")!.offers({ waitMs: 50 }), []);
    assert.equal(remote.pollStats(rob).disconnected, 1);
  } finally { await c.close(); rmSync(d, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }); }
});
