import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { AdmissionService } from "../admission/service.js";
import type { DispatchBody } from "../dispatch/model.js";
import { ManualTimer } from "../dispatch/testing/timer.js";
import { PI } from "../dispatch/testing/world.js";
import { DomainError } from "../domain/errors.js";
import type { EnvironmentFacts, FilesystemDetector } from "../environment/index.js";
import { RemoteWorkerClient, WorkerRequestError, type RemoteAttempt } from "../remote/client.js";
import { PLACEMENT_KIND, type PlacementBody } from "../remote/service.js";
import { PROTOCOL_HEADER, SESSION_HEADER } from "../remote/protocol.js";
import { FULL_ABILITIES } from "../remote/testing/suite.js";
import { rawRequest } from "../remote/testing/world.js";
import { startController, type Controller } from "./index.js";

// Card H09b: two controller instances on one store. The first places an attempt on a remote worker; the second takes the store over. The second never renews the attempt before it has taken it over, the worker's
// earlier session is not accepted there, and the worker takes the attempt up again only by the new controller's decision.

const ext4: FilesystemDetector = async () => ({ type: "ext4", network: false });
const supported: EnvironmentFacts = { platform: "linux", arch: "x64", osRelease: "6.8.0-generic", nodeVersion: "22.19.0" };
const CAPS = { os: "linux", arch: "x64", harnesses: [{ name: "pi", version: "1.3.0" }], isolation: ["bubblewrap"], tools: [], workspaces: [] };
const AGENT = "agt-abcdefghijklmnopqrst";

const open = (d: string, blobs: string): Promise<Controller> => startController({
  storage: { kind: "sqlite", path: join(d, "c.sqlite") }, argv: [], env: {}, print: () => undefined, facts: supported, filesystem: ext4, features: [], harnesses: [PI],
  dispatch: {
    timer: new ManualTimer(), manual: true,
    route: async () => ({ route: "localp/small", harness: "pi", role: "worker", request: { contextTokens: 1000, needs: [], data: "cloud-allowed", paidAuthorized: false } }),
    remote: { blobDirectory: join(d, blobs), hosts: [{ hostId: "host:r1", checkpointWaitMs: 300, pollMs: 20, resources: { cpus: 1, memoryMb: 1024 }, requirements: () => ({ data: "cloud-allowed", harness: "pi" }) }] },
  },
});

interface Setup { readonly ownerToken: string; readonly hostToken: string; readonly attemptId: string; readonly taskId: string }

/** The owner, a project, the remote host r1 (enrolled, with room), an agent and one task with an attempt admitted, on the first controller. */
async function setup(c: Controller): Promise<Setup> {
  const boot = await c.services.principals.bootstrapOwner({ name: "rob" });
  const rob = await c.services.principals.authenticate(boot.token);
  const project = (await c.services.projects.createProject({ commandId: "p1", actor: rob.id, name: "Garden" })).id;
  await c.services.principals.enroll(rob, { commandId: "e-r1", kind: "host", name: "r1", grants: [] });
  const hostToken = (await c.services.principals.issueCredential(rob, "host:r1")).token;
  await AdmissionService.withEpoch(c.storage, c.epoch).setCapacity({ commandId: "cap", actor: rob.id, host: "host:r1", capacity: { cpus: 8, memoryMb: 16_384 } });
  await c.services.principals.enroll(rob, { commandId: "e-ann", kind: "agent", name: AGENT, grants: [{ action: "attempt.work", project }, { action: "task.read", project }, { action: "effect.perform", project }, { action: "review.request", project }] });
  const taskId = (await c.services.projects.createTask({ commandId: "t1", actor: rob.id, projectId: project, title: "Order seeds" })).id;
  await c.services.projects.transitionTask({ commandId: "r1", actor: rob.id, taskId, expectedRevision: 1, to: "ready" });
  await c.services.assignments.assignTask({ commandId: "as1", actor: rob.id, taskId, owner: { kind: "agent", id: AGENT } });
  const a = (await c.services.assignments.getAssignment(taskId))!;
  const attemptId = (await c.services.assignments.admitAttempt({ commandId: "ad1", actor: "inbox", taskId, expectedRevision: a.revision, generation: a.generation, owner: { kind: "agent", id: AGENT }, harness: "pi" })).id;
  return { ownerToken: boot.token, hostToken, attemptId, taskId };
}

/** The worker connects to the controller, the controller offers it the attempt and the worker takes it (accepted and its contract confirmed). */
async function placed(c: Controller, s: Setup): Promise<{ client: RemoteWorkerClient; attempt: RemoteAttempt; placement: number }> {
  const client = new RemoteWorkerClient({ url: c.dispatch!.workerUrl!, token: s.hostToken, workerVersion: "worker-9.1.0" });
  await client.connect(CAPS as never);
  await client.heartbeat(1);
  const report = await c.dispatch!.dispatcher.tick();
  assert.ok(report.started.includes(s.attemptId), JSON.stringify({ s: report.skipped, f: report.failures }));
  const offer = (await client.offers()).find((o) => o.order.attemptId === s.attemptId)!;
  assert.ok(offer, "the attempt was offered");
  const attempt = client.attempt(s.attemptId, offer.placement);
  await attempt.accept();
  assert.deepEqual(await attempt.honorContract(offer.order, FULL_ABILITIES), { ok: true });
  return { client, attempt, placement: offer.placement };
}

const dispatchOf = async (c: Controller, attemptId: string): Promise<DispatchBody> => (await c.storage.listAggregates("dispatch", { limit: 50 })).map((r) => r.body as unknown as DispatchBody).find((b) => b.attemptId === attemptId)!;
const placementOf = async (c: Controller, attemptId: string): Promise<PlacementBody> => (await c.storage.getAggregate({ kind: PLACEMENT_KIND, id: attemptId }))!.body as unknown as PlacementBody;
const rejectsWith = async (code: string, run: () => Promise<unknown>): Promise<void> => {
  await assert.rejects(run, (e: unknown) => { assert.ok((e instanceof DomainError || e instanceof WorkerRequestError) && e.code === code, String(e)); return true; });
};
const call = async (c: Controller, token: string, op: string, args: Record<string, unknown>, commandId?: string): Promise<{ ok: boolean; result?: any; error?: { code: string; message: string } }> =>
  c.api.handle(token, { v: 1, op, ...(commandId === undefined ? {} : { commandId }), args } as never) as never;

test("a new primary does not renew a remote attempt it did not start until it has taken it over, refuses the worker's earlier session, and the worker takes the attempt up again only by the new primary's decision (card H09b, two controllers on one store)", async () => {
  const d = mkdtempSync(join(tmpdir(), "nn-h09b-"));
  const first = await open(d, "blobs-1");
  try {
    assert.ok(first.dispatch?.workerUrl !== undefined, first.dispatchProblem);
    const s = await setup(first);
    const { client, attempt, placement } = await placed(first, s);
    assert.equal(client.session!.primaryEpoch, first.epoch);
    await attempt.heartbeat();
    const startedUnder = await dispatchOf(first, s.attemptId);
    assert.equal(startedUnder.primaryEpoch, first.epoch);

    // The second controller takes the store over.
    const second = await open(d, "blobs-2");
    try {
      assert.ok(second.dispatch?.workerUrl !== undefined, second.dispatchProblem);
      assert.ok(second.epoch > first.epoch);
      // The old primary cannot renew any more: its write is refused on the epoch.
      await rejectsWith("stale_epoch", () => attempt.heartbeat());
      const before = await dispatchOf(second, s.attemptId);
      // The worker's earlier session is not accepted by the new primary: a heartbeat of the attempt under it is fenced (connect again), and nothing is renewed.
      const old = await rawRequest(second.dispatch!.workerUrl!, "POST", `/worker/attempts/${s.attemptId}/heartbeat`, { token: s.hostToken, body: { placement }, headers: { [SESSION_HEADER]: client.session!.sessionId, [PROTOCOL_HEADER]: String(client.session!.protocol), "idempotency-key": "hb-old" } });
      assert.deepEqual([old.status, old.body?.error?.code], [409, "fenced"], JSON.stringify(old.body));
      // The new primary itself does not renew the attempt before it has taken it over.
      await rejectsWith("unavailable", () => second.dispatch!.dispatcher.heartbeat(s.attemptId));
      assert.deepEqual(await dispatchOf(second, s.attemptId), before, "nothing renewed");

      // The worker connects to the new primary: the session names it, and the handshake decides (the default strict profile: the owner decides).
      const moved = new RemoteWorkerClient({ url: second.dispatch!.workerUrl!, token: s.hostToken, workerVersion: "worker-9.1.0" });
      const session = await moved.connect(CAPS as never);
      assert.equal(session.primaryEpoch, second.epoch);
      await moved.heartbeat(2);
      const handshake = await moved.reconcile([{ attemptId: s.attemptId, placement }]);
      assert.deepEqual([handshake.mode, handshake.verdicts[0]!.verdict], ["owner", "pending"]);
      const again = moved.attempt(s.attemptId, placement);
      await assert.rejects(() => again.accept(), (e: unknown) => e instanceof WorkerRequestError && e.waitingForOwner);
      await rejectsWith("fenced", () => again.heartbeat());
      // Waiting for the owner did not renew the lease either: the new primary has not taken the attempt over yet.
      assert.deepEqual((await dispatchOf(second, s.attemptId)).lease, before.lease);

      // The new primary's tick takes the attempt over: from now on its lease is this controller's to renew.
      const tick = await second.dispatch!.dispatcher.tick();
      assert.deepEqual(tick.adopted, [s.attemptId], JSON.stringify(tick));
      const adopted = await dispatchOf(second, s.attemptId);
      assert.equal(adopted.primaryEpoch, second.epoch);
      assert.equal(adopted.state, "running");
      assert.ok(adopted.adoptedAt !== undefined && adopted.lease !== undefined && adopted.lease.until > before.lease!.until);
      // Taken over is not resumed: the worker still waits for the owner.
      await assert.rejects(() => again.accept(), (e: unknown) => e instanceof WorkerRequestError && e.waitingForOwner);
      // The owner approves the session that waits; the worker takes the attempt up again, renews it, and its result ends it on the new primary.
      const waiting = await call(second, s.ownerToken, "reconnect.pending", {});
      assert.ok(waiting.ok, JSON.stringify(waiting));
      const item = waiting.result.items.find((x: { attemptId: string }) => x.attemptId === s.attemptId);
      assert.equal(item.sessionId, session.sessionId);
      const approved = await call(second, s.ownerToken, "reconnect.reaccept", { attemptId: s.attemptId, placement, sessionId: item.sessionId, waitingSince: item.at, decision: "approve" }, "ok-1");
      assert.ok(approved.ok, JSON.stringify(approved));
      assert.equal((await again.accept()).placement, placement);
      const beats = (await dispatchOf(second, s.attemptId)).heartbeats;
      const beat = await again.heartbeat();
      assert.ok(beat.until >= adopted.lease!.until);
      assert.equal((await dispatchOf(second, s.attemptId)).heartbeats, beats + 1, "the worker's own heartbeat counts now");
      await again.complete({ status: "completed" } as never);
      await second.dispatch!.dispatcher.idle();
      const done = await dispatchOf(second, s.attemptId);
      assert.deepEqual([done.state, done.outcome?.status], ["finished", "succeeded"]);
    } finally { await second.close(); }
  } finally { await first.close(); rmSync(d, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }); }
});

test("a new primary ends a remote attempt whose run is gone (only offered when the old controller stopped: the offer died with it) and admits a replacement; one whose worker already sent its result is taken with that result (card H09b, two controllers on one store)", async () => {
  const d = mkdtempSync(join(tmpdir(), "nn-h09b-"));
  const first = await open(d, "blobs-1");
  try {
    assert.ok(first.dispatch?.workerUrl !== undefined, first.dispatchProblem);
    const s = await setup(first);
    // The first controller offers the attempt; the worker never takes it.
    const client = new RemoteWorkerClient({ url: first.dispatch!.workerUrl!, token: s.hostToken, workerVersion: "worker-9.1.0" });
    await client.connect(CAPS as never);
    await client.heartbeat(1);
    assert.ok((await first.dispatch!.dispatcher.tick()).started.includes(s.attemptId));
    assert.equal((await placementOf(first, s.attemptId)).state, "offered");
    const second = await open(d, "blobs-2");
    try {
      const tick = await second.dispatch!.dispatcher.tick();
      assert.ok(tick.lost.includes(s.attemptId), JSON.stringify(tick));
      assert.deepEqual(tick.adopted, []);
      const ended = await dispatchOf(second, s.attemptId);
      assert.deepEqual([ended.state, ended.outcome?.status], ["finished", "abandoned"]);
      assert.match(ended.outcome!.summary, /no longer runs it/);
      assert.equal((await placementOf(second, s.attemptId)).state, "ended", "the placement is let go, so the agent's store is free");
      assert.equal(tick.readmitted.length, 1, "a replacement is admitted");
      const replacement = tick.readmitted[0]!;

      // The replacement runs on the second controller; a third controller takes over after the worker sent its result while nobody had taken the attempt over: the result is taken, not lost.
      const moved = new RemoteWorkerClient({ url: second.dispatch!.workerUrl!, token: s.hostToken, workerVersion: "worker-9.1.0" });
      await moved.connect(CAPS as never);
      await moved.heartbeat(2);
      // The same tick admitted it and placed it on r1 (the host was fresh from the first controller's time).
      assert.ok(tick.started.includes(replacement), JSON.stringify(tick));
      const offer = (await moved.offers()).find((o) => o.order.attemptId === replacement)!;
      const run = moved.attempt(replacement, offer.placement);
      await run.accept();
      assert.deepEqual(await run.honorContract(offer.order, FULL_ABILITIES), { ok: true });
      assert.ok((await call(second, s.ownerToken, "reconnect.settings.set", { reaccept: "auto" }, "auto-1")).ok);
      const third = await open(d, "blobs-3");
      try {
        const last = new RemoteWorkerClient({ url: third.dispatch!.workerUrl!, token: s.hostToken, workerVersion: "worker-9.1.0" });
        await last.connect(CAPS as never);
        await last.heartbeat(3);
        assert.equal((await last.reconcile([{ attemptId: replacement, placement: offer.placement }])).verdicts[0]!.verdict, "reaccept");
        const resumed = last.attempt(replacement, offer.placement);
        await resumed.accept();
        // Before the takeover the heartbeat is refused as a passing condition (ask again), not as the end of the attempt.
        await rejectsWith("unavailable", () => resumed.heartbeat());
        await resumed.complete({ status: "completed" } as never);
        assert.equal((await placementOf(third, replacement)).state, "completed");
        const taken = await third.dispatch!.dispatcher.tick();
        assert.deepEqual(taken.adopted, [replacement], JSON.stringify(taken));
        await third.dispatch!.dispatcher.idle();
        const done = await dispatchOf(third, replacement);
        assert.deepEqual([done.state, done.outcome?.status, done.primaryEpoch], ["finished", "succeeded", third.epoch]);
      } finally { await third.close(); }
    } finally { await second.close(); }
  } finally { await first.close(); rmSync(d, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }); }
});
