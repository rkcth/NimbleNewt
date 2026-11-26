import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { AdmissionService } from "../admission/service.js";
import type { EnvironmentFacts, FilesystemDetector } from "../environment/index.js";
import { ManualTimer } from "../dispatch/testing/timer.js";
import { PI, ScriptedWorker, workGrants } from "../dispatch/testing/world.js";
import { HostService } from "../hosts/hosts.js";
import { RemoteWorkerClient } from "../remote/index.js";
import { WORKER_PROTOCOL } from "../remote/protocol.js";
import { startController } from "./index.js";

// Card U08d second review: the compatibility status read through a composed controller whose agents run on a host inside the controller (the "run agents on this computer" set-up), with a
// database that has migrations waiting. Before the review the in-process host was told as "not connected" (it never opens a remote session) and an attempt running on it was not among what a
// waiting migration interrupts (only a remote host's store record named running attempts).
const ext4: FilesystemDetector = async () => ({ type: "ext4", network: false });
const supported: EnvironmentFacts = { platform: "linux", arch: "x64", osRelease: "6.8.0-generic", nodeVersion: "22.19.0" };
const CAPS = { os: "linux", arch: "x64", harnesses: [{ name: "pi", version: "1.3.0" }], isolation: ["bubblewrap"], tools: [], workspaces: [] };

test("an in-process host is current, and an attempt running on it is what a waiting migration interrupts (card U08d, composed controller)", async () => {
  const d = mkdtempSync(join(tmpdir(), "nn-u08d-"));
  // Agents on the local host run until they are stopped.
  const host = new ScriptedWorker("host:w1", async ({ worker }) => {
    await new Promise<void>((done) => { const stop = worker.stop.bind(worker); worker.stop = async () => { await stop(); done(); }; });
    return { status: "completed", text: "stopped" };
  });
  const c = await startController({
    storage: { kind: "sqlite", path: join(d, "c.sqlite") }, argv: [], env: {}, print: () => undefined, facts: supported, filesystem: ext4, features: [], harnesses: [PI],
    // The release options let the test say the database is at schema 0, so its migrations wait.
    releases: { root: join(d, "rel"), switcher: "pointer", platform: { os: "linux", arch: "x64" }, schemaVersion: async () => 0 },
    dispatch: {
      timer: new ManualTimer(), manual: true,
      route: async () => ({ route: "cloud/small", harness: "pi", role: "worker", request: { contextTokens: 1000, needs: [], data: "cloud-allowed", paidAuthorized: true } }),
      local: { acceptUnenforcedLimits: true, window: () => 8192, build: () => host },
    },
  });
  try {
    assert.ok(c.dispatch !== undefined, c.dispatchProblem);
    const boot = await c.services.principals.bootstrapOwner({ name: "rob" });
    const owner = await c.services.principals.authenticate(boot.token);
    const project = (await c.services.projects.createProject({ commandId: "p1", actor: owner.id, name: "Garden" })).id;
    await c.services.principals.enroll(owner, { commandId: "e-w1", kind: "host", name: "w1", grants: [] });
    const hostP = await c.services.principals.authenticate((await c.services.principals.issueCredential(owner, "host:w1")).token);
    const hosts = HostService.withEpoch(c.storage, c.epoch, c.services.assignments);
    await hosts.announce(hostP, { commandId: "an1", capabilities: CAPS as never });
    await hosts.heartbeat(hostP, { commandId: "hb1", sequence: 1 });
    await AdmissionService.withEpoch(c.storage, c.epoch).setCapacity({ commandId: "cap-w1", actor: owner.id, host: "host:w1", capacity: { cpus: 32, memoryMb: 65_536 } });
    const agent = (await c.services.agents.create(owner, { commandId: "ag-1", friendlyName: "Ann" })).id;
    for (const g of [{ action: "task.read" }, ...workGrants(project, ["read-file"]), { action: "history.read" }]) await c.services.grants.grant(owner, { commandId: `g-${g.action}`, grantee: `agent:${agent}`, action: g.action, project, source: "direct", basis: "test" } as never);
    // An agent with no agent record (an enrolled name) works too; its running attempt counts as well.
    await c.services.principals.enroll(owner, { commandId: "e-bare", kind: "agent", name: "agt-bbbbbbbbbbbbbbbbbbbb", grants: workGrants(project, ["read-file"]) });
    const admit = async (n: number, who: string): Promise<string> => {
      const id = (await c.services.projects.createTask({ commandId: `t${n}`, actor: owner.id, projectId: project, title: `Order seeds ${n}` })).id;
      await c.services.projects.transitionTask({ commandId: `r${n}`, actor: owner.id, taskId: id, expectedRevision: 1, to: "ready" });
      await c.services.assignments.assignTask({ commandId: `as${n}`, actor: owner.id, taskId: id, owner: { kind: "agent", id: who } });
      const a = (await c.services.assignments.getAssignment(id))!;
      return (await c.services.assignments.admitAttempt({ commandId: `ad${n}`, actor: "inbox", taskId: id, expectedRevision: a.revision, generation: a.generation, owner: { kind: "agent", id: who }, harness: "pi" })).id;
    };
    const first = await admit(1, agent);
    const second = await admit(2, "agt-bbbbbbbbbbbbbbbbbbbb");
    await c.dispatch!.dispatcher.tick();
    for (const id of [first, second]) assert.notEqual((await c.dispatch!.dispatcher.get(c.dispatch!.principal, id))?.state, "finished", "the attempt is live");

    const got = await c.api.handle(boot.token, { v: 1, op: "compatibility.status", args: {} } as never) as { ok: boolean; result?: any };
    assert.ok(got.ok, JSON.stringify(got));
    const item = got.result.item;
    const w1 = item.hosts.find((h: { hostId: string }) => h.hostId === "host:w1");
    assert.equal(w1?.state, "current", JSON.stringify(item.hosts));
    assert.equal(w1.protocol, WORKER_PROTOCOL.max);
    assert.match(w1.note, /inside this controller/);
    assert.ok(item.migration.pending.length > 0, `the migrations above schema 0 wait: ${JSON.stringify(item.migration)}`);
    const ops = (item.migration.operations as string[]).join("\n");
    assert.match(ops, new RegExp(`attempt ${first} of Ann`), ops);
    assert.match(ops, new RegExp(`attempt ${second} of `), ops);
    assert.ok((item.migration.agents as string[]).some((a) => /^Ann \(/.test(a)), JSON.stringify(item.migration.agents));
    assert.equal(item.status, "attention");

    // The same in the chat's status kind.
    const said = await c.api.handle(boot.token, { v: 1, op: "status.ask", args: { request: { kind: "compatibility" } } } as never) as { ok: boolean; result?: any };
    const text = (said.result.item.lines as { text: string }[]).map((l) => l.text).join("\n");
    assert.match(text, /Host host:w1: current/, text);
    assert.match(text, new RegExp(`It would touch: .*attempt ${first} of Ann`), text);
    assert.doesNotMatch(text, /not connected/);

    // Once the attempts end, a waiting migration interrupts nothing.
    for (const [i, id] of [first, second].entries()) await c.api.handle(boot.token, { v: 1, op: "lifecycle.stop", commandId: `st${i}`, args: { scope: { kind: "task", id: (await c.dispatch!.dispatcher.get(c.dispatch!.principal, id))!.taskId }, mode: "stop", reason: "done" } } as never);
    for (const id of [first, second]) assert.equal((await c.dispatch!.dispatcher.get(c.dispatch!.principal, id))?.state, "finished");
    const calm = (await c.api.handle(boot.token, { v: 1, op: "compatibility.status", args: {} } as never) as { result: any }).result.item;
    assert.deepEqual([calm.migration.agents, calm.migration.operations], [[], []], JSON.stringify(calm.migration));
  } finally { await c.close(); rmSync(d, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }); }
});

test("a remote host whose worker speaks an older protocol names the agents whose store it holds, and one turned away is refused (card U08d, composed controller)", async () => {
  const d = mkdtempSync(join(tmpdir(), "nn-u08d-"));
  const remoteHost = (hostId: string) => ({ hostId, window: () => 131_072, checkpointWaitMs: 300, pollMs: 20, resources: { cpus: 1, memoryMb: 1024 }, requirements: () => ({ data: "cloud-allowed" as const, harness: "pi" }) });
  const c = await startController({
    storage: { kind: "sqlite", path: join(d, "c.sqlite") }, argv: [], env: {}, print: () => undefined, facts: supported, filesystem: ext4, features: [], harnesses: [PI],
    dispatch: {
      timer: new ManualTimer(), manual: true,
      route: async () => ({ route: "localp/small", harness: "pi", role: "worker", request: { contextTokens: 1000, needs: [], data: "cloud-allowed", paidAuthorized: false } }),
      remote: { workspaceAdmission: async () => [], blobDirectory: join(d, "blobs"), hosts: [remoteHost("host:r1"), remoteHost("host:r2")] },
    },
  });
  try {
    assert.ok(c.dispatch?.workerUrl !== undefined, c.dispatchProblem);
    assert.deepEqual(c.dispatch!.inProcessHosts, [], "remote hosts are not in-process hosts");
    const boot = await c.services.principals.bootstrapOwner({ name: "rob" });
    const rob = await c.services.principals.authenticate(boot.token);
    const project = (await c.services.projects.createProject({ commandId: "p1", actor: rob.id, name: "Garden" })).id;
    const tokens: Record<string, string> = {};
    for (const n of ["r1", "r2"]) {
      await c.services.principals.enroll(rob, { commandId: `e-${n}`, kind: "host", name: n, grants: [] });
      tokens[n] = (await c.services.principals.issueCredential(rob, `host:${n}`)).token;
    }
    await AdmissionService.withEpoch(c.storage, c.epoch).setCapacity({ commandId: "cap", actor: rob.id, host: "host:r1", capacity: { cpus: 8, memoryMb: 16_384 } });
    const agent = (await c.services.agents.create(rob, { commandId: "ag-1", friendlyName: "Ann" })).id;
    for (const g of [{ action: "attempt.work" }, { action: "task.read" }, { action: "effect.perform" }, { action: "review.request" }]) await c.services.grants.grant(rob, { commandId: `g-${g.action}`, grantee: `agent:${agent}`, action: g.action, project, source: "direct", basis: "test" } as never);
    const task = (await c.services.projects.createTask({ commandId: "t1", actor: rob.id, projectId: project, title: "Order seeds" })).id;
    await c.services.projects.transitionTask({ commandId: "r1", actor: rob.id, taskId: task, expectedRevision: 1, to: "ready" });
    await c.services.assignments.assignTask({ commandId: "as1", actor: rob.id, taskId: task, owner: { kind: "agent", id: agent } });
    const a = (await c.services.assignments.getAssignment(task))!;
    const attemptId = (await c.services.assignments.admitAttempt({ commandId: "ad1", actor: "inbox", taskId: task, expectedRevision: a.revision, generation: a.generation, owner: { kind: "agent", id: agent }, harness: "pi" })).id;

    // host:r2's worker speaks only a protocol this controller does not: turned away. host:r1's speaks only the oldest one this controller still speaks.
    // host:r2 announced itself before (an older worker ran there); its worker was replaced by one this controller cannot speak to. (A host turned away before it ever announced has no host record, so it is not listed: a stated limit.)
    await HostService.withEpoch(c.storage, c.epoch, c.services.assignments).announce(await c.services.principals.authenticate(tokens["r2"]!), { commandId: "an-r2", capabilities: CAPS as never });
    const tooNew = new RemoteWorkerClient({ url: c.dispatch!.workerUrl!, token: tokens["r2"]!, workerVersion: "w-99", protocol: { min: 99, max: 99 } } as never);
    await assert.rejects(() => tooNew.connect(CAPS as never));
    const old = new RemoteWorkerClient({ url: c.dispatch!.workerUrl!, token: tokens["r1"]!, workerVersion: "worker-1.0.0", protocol: { min: WORKER_PROTOCOL.min, max: WORKER_PROTOCOL.min } } as never);
    await old.connect(CAPS as never);
    await old.heartbeat(1);
    const report = await c.dispatch!.dispatcher.tick();
    assert.ok(report.started.includes(attemptId), JSON.stringify({ s: report.skipped, f: report.failures, w: report.waiting, b: report.blocked }));
    const offer = (await old.offers()).find((o) => o.order.attemptId === attemptId);
    assert.ok(offer, "the attempt was offered to host:r1");
    await old.attempt(attemptId, offer!.placement).accept();

    const got = await c.api.handle(boot.token, { v: 1, op: "compatibility.status", args: {} } as never) as { ok: boolean; result?: any };
    assert.ok(got.ok, JSON.stringify(got));
    const by = Object.fromEntries((got.result.item.hosts as { hostId: string }[]).map((h) => [h.hostId, h])) as Record<string, any>;
    assert.equal(by["host:r1"]?.state, WORKER_PROTOCOL.min < WORKER_PROTOCOL.max ? "older" : "current", JSON.stringify(got.result.item.hosts));
    assert.equal(by["host:r1"].workerVersion, "worker-1.0.0");
    if (WORKER_PROTOCOL.min < WORKER_PROTOCOL.max) assert.deepEqual(by["host:r1"].agents, [`Ann (${agent})`], "the agent whose store host:r1 holds is affected");
    assert.equal(by["host:r2"]?.state, "refused");
    assert.deepEqual(by["host:r2"].agents, [], "no agent's store is on the host that was turned away");
  } finally { await c.close(); rmSync(d, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }); }
});
