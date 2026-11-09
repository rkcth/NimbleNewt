import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { AdmissionService } from "../admission/service.js";
import { ManualTimer } from "../dispatch/testing/timer.js";
import { PI } from "../dispatch/testing/world.js";
import type { EnvironmentFacts, FilesystemDetector } from "../environment/index.js";
import { RemoteWorkerClient } from "../remote/index.js";
import { startTestServer, withClient, type TestServer } from "../storage/postgres/testing/server.js";
import { startController, type StartOptions } from "./index.js";

/**
 * Card C07o through the composed controller: an attempt placed on a remote host has its first call judged by the controller before the host is offered the order, against the route's window (here the operator's figure
 * for the host, 4096 tokens: a first call of at most 1024), with the same admission record and `context_overflow` blocker as the local worker's. The host is a real worker client over the real transport.
 */
const ext4: FilesystemDetector = async () => ({ type: "ext4", network: false });
const supported: EnvironmentFacts = { platform: "linux", arch: "x64", osRelease: "6.8.0-generic", nodeVersion: "22.19.0" };
const CAPS = { os: "linux", arch: "x64", harnesses: [{ name: "pi", version: "1.3.0" }], isolation: ["bubblewrap"], tools: [], workspaces: [] };
const ANN = "agt-abcdefghijklmnopqrst";

// The stores a controller can be started on (the reference store and the worker-thread SQLite are covered by `remote/host-context.test.ts`). The typical tier runs SQLite only.
let server: Promise<TestServer> | undefined;
after(async () => { if (server !== undefined) await (await server).stop(); });
interface Store { readonly name: string; open(dir: string): Promise<{ storage: StartOptions["storage"]; close(): Promise<void> }> }
const stores: Store[] = [
  { name: "SQLite", open: async (d) => ({ storage: { kind: "sqlite", path: join(d, "c.sqlite") }, close: async () => undefined }) },
  ...(process.env["NIMBLENEWT_TIER"] === "typical" ? [] : [{ name: "PostgreSQL", open: async () => {
    server ??= startTestServer();
    const s = await server;
    const schema = `c07o_${process.pid}_${Math.random().toString(36).slice(2, 8)}`;
    return { storage: { kind: "postgres" as const, url: s.url(), schema }, close: async () => { await withClient(s.url(), async (cl) => { await cl.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`); }); } };
  } }]),
];

for (const store of stores) {
  test(`${store.name}: a remote host is offered only a first call that fits the route's window; an oversized one is refused before the offer, recorded like the local worker's and blocked for the owner (card C07o)`, async () => {
    const d = mkdtempSync(join(tmpdir(), "nn-c07o-"));
    const db = await store.open(d);
    const c = await startController({
      storage: db.storage, argv: [], env: {}, print: () => undefined, facts: supported, filesystem: ext4, features: [], harnesses: [PI],
      dispatch: {
        timer: new ManualTimer(), manual: true,
        route: async () => ({ route: "localp/small", harness: "pi", role: "worker", request: { contextTokens: 1000, needs: [], data: "cloud-allowed", paidAuthorized: false } }),
        remote: { blobDirectory: join(d, "blobs"), hosts: [{ hostId: "host:r1", window: () => 4096, checkpointWaitMs: 300, pollMs: 20, resources: { cpus: 1, memoryMb: 1024 }, requirements: () => ({ data: "cloud-allowed", harness: "pi" }) }] },
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
      await c.services.principals.enroll(rob, { commandId: "e-ann", kind: "agent", name: ANN, grants: [{ action: "attempt.work", project }, { action: "task.read", project }] as never });
      const client = new RemoteWorkerClient({ url: c.dispatch!.workerUrl!, token: hostToken, workerVersion: "worker-9.1.0" });
      await client.connect(CAPS as never);
      let beat = 0;
      await client.heartbeat(++beat);
      let n = 0;
      const attempt = async (title: string, description: string) => {
        const k = n++;
        const task = (await c.services.projects.createTask({ commandId: `t${k}`, actor: rob.id, projectId: project, title, description })).id;
        await c.services.projects.transitionTask({ commandId: `r${k}`, actor: rob.id, taskId: task, expectedRevision: 1, to: "ready" });
        await c.services.assignments.assignTask({ commandId: `as${k}`, actor: rob.id, taskId: task, owner: { kind: "agent", id: ANN } });
        const a = (await c.services.assignments.getAssignment(task))!;
        const attemptId = (await c.services.assignments.admitAttempt({ commandId: `ad${k}`, actor: "inbox", taskId: task, expectedRevision: a.revision, generation: a.generation, owner: { kind: "agent", id: ANN }, harness: "pi" })).id;
        await client.heartbeat(++beat);
        const report = await c.dispatch!.dispatcher.tick();
        return { task, attemptId, report };
      };
      const admissions = async (taskId: string) => (await c.storage.listAggregates("ctx-admission", { limit: 50 })).map((x) => x.body as unknown as { taskId: string; type: string; admit: boolean; window: number }).filter((b) => b.taskId === taskId).map((b) => [b.type, b.admit, b.window]);
      const blockerOf = async (taskId: string) => (await c.storage.listAggregates("blocker", { limit: 50 })).map((x) => x.body as unknown as { type: string; state: string; subject: { id: string }; summary: string }).find((b) => b.type === "context_overflow" && b.state === "open" && b.subject.id === taskId);

      // 8000 characters of task text is about 2,700 tokens: over the 1024-token first call of a 4096-token window. The host is never offered it.
      const big = await attempt("Plan the whole garden", "Plant ".repeat(1333));
      assert.equal((await client.offers()).some((o) => o.order.attemptId === big.attemptId), false, "an oversized first call was offered to the remote host");
      // The refused attempt's turn ends at once (an offered one would wait on the host forever: the wait is bounded so a regression fails rather than hangs).
      await Promise.race([c.dispatch!.dispatcher.idle(), new Promise((resolve) => setTimeout(resolve, 10_000))]);
      const failed = (await c.dispatch!.dispatcher.get(rob, big.attemptId))!;
      assert.equal(failed.outcome?.status, "failed", JSON.stringify(failed.outcome));
      assert.match(failed.outcome?.summary ?? "", /first call was not sent.*startup limit of 1024/s, failed.outcome?.summary);
      assert.deepEqual(await admissions(big.task), [["first-call", false, 4096]]);
      const blocker = await blockerOf(big.task);
      assert.ok(blocker, "no context_overflow blocker for the owner");
      assert.match(blocker.summary, /was not sent/);

      // A short task fits: it is offered to the host, with its admission on record, and nothing blocks it.
      const small = await attempt("Order seeds", "Two packets of beans.");
      assert.ok(small.report.started.includes(small.attemptId), JSON.stringify({ s: small.report.skipped, f: small.report.failures }));
      const offer = (await client.offers()).find((o) => o.order.attemptId === small.attemptId);
      assert.ok(offer, "the fitting first call was not offered");
      assert.match(offer.order.content, /Two packets of beans/);
      assert.deepEqual(await admissions(small.task), [["first-call", true, 4096]]);
      assert.equal(await blockerOf(small.task), undefined);
    } finally {
      await c.close();
      await db.close();
      rmSync(d, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
    }
  });
}
