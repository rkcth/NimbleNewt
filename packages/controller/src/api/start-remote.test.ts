import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
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

test("the composed controller places an attempt on a remote host over its own transport; the worker fetches the order, cannot admit work, an incompatible protocol is refused (card H02: composed placement and protocol negotiation)", async () => {
  const d = mkdtempSync(join(tmpdir(), "nn-remote-"));
  const c = await startController({
    storage: { kind: "sqlite", path: join(d, "c.sqlite") }, argv: [], env: {}, print: () => undefined, facts: supported, filesystem: ext4, features: [], harnesses: [PI],
    dispatch: {
      timer: new ManualTimer(), manual: true,
      route: async () => ({ route: "localp/small", harness: "pi", role: "worker", request: { contextTokens: 1000, needs: [], data: "cloud-allowed", paidAuthorized: false } }),
      remote: { blobDirectory: join(d, "blobs"), hosts: [{ hostId: "host:r1", checkpointWaitMs: 300, pollMs: 20, resources: { cpus: 1, memoryMb: 1024 }, requirements: () => ({ data: "cloud-allowed", harness: "pi" }) }] },
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
    assert.equal(api.ok, false);
    assert.equal((api as { error?: { code: string } }).error?.code, "forbidden", "a remote worker cannot create projects");
    // The dispatcher names the host the agent's attempt runs on.
    const owner = await c.dispatch!.hostOfAgent("agent:agt-abcdefghijklmnopqrst");
    assert.equal(owner, "host:r1");
  } finally { await c.close(); rmSync(d, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }); }
});

test("a step that fails after the local host was built closes that host again, whichever step it is, and the controller says why the dispatcher is not running (card H02b)", async () => {
  const d = mkdtempSync(join(tmpdir(), "nn-remote-"));
  try {
    // The artifact folder cannot be opened (its parent is a file): the local host built just before is closed.
    writeFileSync(join(d, "afile"), "x");
    let closed = 0;
    const local = { window: () => 8192, close: async () => { closed++; }, build: () => ({ hostId: "host:w1", resources: { cpus: 1, memoryMb: 1024 } }) as never };
    const c = await startController({
      storage: { kind: "sqlite", path: join(d, "c.sqlite") }, argv: [], env: {}, print: () => undefined, facts: supported, filesystem: ext4, features: [], harnesses: [PI],
      dispatch: { timer: new ManualTimer(), manual: true, local, remote: { blobDirectory: join(d, "afile", "blobs"), hosts: [] } },
    });
    try {
      assert.equal(c.dispatch, undefined);
      assert.ok(c.dispatchProblem !== undefined && c.dispatchProblem.length > 0);
      assert.equal(closed, 1, "the local host built before the failure was closed");
    } finally { await c.close(); }
    assert.equal(closed, 1, "and not closed a second time by the controller's own close");
    // A listener that cannot start (a port already taken) closes it as well.
    const net = await import("node:net");
    const taken = net.createServer();
    await new Promise<void>((ok) => taken.listen(0, "127.0.0.1", ok));
    const port = (taken.address() as { port: number }).port;
    try {
      const c2 = await startController({
        storage: { kind: "sqlite", path: join(d, "c2.sqlite") }, argv: [], env: {}, print: () => undefined, facts: supported, filesystem: ext4, features: [], harnesses: [PI],
        dispatch: { timer: new ManualTimer(), manual: true, local, remote: { blobDirectory: join(d, "blobs2"), hosts: [], transport: { port } as never } },
      });
      try { assert.equal(c2.dispatch, undefined); assert.equal(closed, 2); } finally { await c2.close(); }
    } finally { await new Promise<void>((ok) => taken.close(() => ok())); }
  } finally { rmSync(d, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }); }
});


test("a host that cannot meet the attempt's requirements is not given it: the refusal names the unmet requirement and the attempt does not start there (card H02b)", async () => {
  const d = mkdtempSync(join(tmpdir(), "nn-remote-"));
  const c = await startController({
    storage: { kind: "sqlite", path: join(d, "c.sqlite") }, argv: [], env: {}, print: () => undefined, facts: supported, filesystem: ext4, features: [], harnesses: [PI],
    dispatch: {
      timer: new ManualTimer(), manual: true,
      route: async () => ({ route: "localp/small", harness: "pi", role: "worker", request: { contextTokens: 1000, needs: [], data: "cloud-allowed", paidAuthorized: false } }),
      remote: { blobDirectory: join(d, "blobs"), hosts: [{ hostId: "host:r1", checkpointWaitMs: 300, pollMs: 20, resources: { cpus: 1, memoryMb: 1024 }, requirements: () => ({ data: "cloud-allowed", harness: "pi", isolation: ["firecracker"] }) }] },
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

    const client = new RemoteWorkerClient({ url: c.dispatch!.workerUrl!, token: hostToken, workerVersion: "worker-9.1.0" });
    await client.connect(CAPS as never);
    await client.heartbeat(1);
    const report = await c.dispatch!.dispatcher.tick();
    assert.ok(!report.started.includes(attemptId), "not started on a host that cannot isolate it");
    const why = JSON.stringify({ s: report.skipped, f: report.failures, w: report.waiting, b: report.blocked });
    assert.match(why, /firecracker|isolation|requirement/i, why);
    assert.deepEqual(await client.offers(), [], "nothing was offered to that host");
  } finally { await c.close(); rmSync(d, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }); }
});

test("a failure after the listener opened (while the driver or the MCP service is built) leaves nothing listening and nothing ticking, and the local host is closed once (card H02c)", async () => {
  const d = mkdtempSync(join(tmpdir(), "nn-remote-"));
  const net = await import("node:net");
  const freePort = async (): Promise<number> => { const s = net.createServer(); await new Promise<void>((ok) => s.listen(0, "127.0.0.1", ok)); const p = (s.address() as { port: number }).port; await new Promise<void>((ok) => s.close(() => ok())); return p; };
  let restore = (): void => undefined;
  const refused = (port: number): Promise<boolean> => new Promise((ok) => { const s = net.connect(port, "127.0.0.1"); s.once("connect", () => { s.destroy(); ok(false); }); s.once("error", () => ok(true)); });
  try {
    let closed = 0;
    const local = { window: () => 8192, close: async () => { closed++; }, build: () => ({ hostId: "host:w1", resources: { cpus: 1, memoryMb: 1024 } }) as never };
    // The failure is injected where the listener is already open: the servers that listen are watched, and at the moment of the failure one must be listening on the port.
    const http = await import("node:http");
    const servers: import("node:http").Server[] = [];
    const listen = http.Server.prototype.listen;
    http.Server.prototype.listen = function (this: import("node:http").Server, ...args: never[]) { servers.push(this); return (listen as (...a: never[]) => import("node:http").Server).apply(this, args); } as never;
    restore = () => { http.Server.prototype.listen = listen; };
    const openAt: boolean[] = [];
    let probePort = 0;
    const boom = (): never => {
      openAt.push(servers.some((s) => s.listening && (s.address() as { port?: number } | null)?.port === probePort));
      throw new Error("injected failure");
    };
    for (const [n, inject] of [["driver", (o: Record<string, unknown>) => { Object.defineProperty(o, "intervalMs", { get: boom, enumerable: true }); }], ["mcp", (o: Record<string, unknown>) => { o["mcp"] = { resolve: async () => undefined, get gate() { return boom(); } }; }]] as const) {
      const port = await freePort();
      probePort = port;
      openAt.length = 0;
      const timer = new ManualTimer();
      const dispatch: Record<string, unknown> = { timer, local, remote: { blobDirectory: join(d, `blobs-${n}`), hosts: [], transport: { port } } };
      inject(dispatch);
      const c = await startController({ storage: { kind: "sqlite", path: join(d, `${n}.sqlite`) }, argv: [], env: {}, print: () => undefined, facts: supported, filesystem: ext4, features: [], harnesses: [PI], dispatch: dispatch as never });
      try {
        assert.equal(c.dispatch, undefined, n);
        assert.match(c.dispatchProblem ?? "", /injected failure/, n);
        assert.deepEqual(openAt, [true], `${n}: the listener was open when the step failed`);
        assert.equal(await refused(port), true, `${n}: the listener that was opened is closed`);
        assert.equal(timer.armed, false, `${n}: nothing is ticking`);
        assert.deepEqual(timer.delays, [], `${n}: no timer was ever asked for`);
      } finally { await c.close(); }
    }
    assert.equal(closed, 2, "the local host was closed once for each failed start");
  } finally { restore(); rmSync(d, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }); }
});
