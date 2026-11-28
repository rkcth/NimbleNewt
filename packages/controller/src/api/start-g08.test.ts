import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { request as httpRequest } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { AdmissionService } from "../admission/service.js";
import { FileBlobStore } from "../artifacts/index.js";
import type { DispatchBody } from "../dispatch/model.js";
import type { WorkOrder } from "../dispatch/ports.js";
import { ManualTimer } from "../dispatch/testing/timer.js";
import { PI } from "../dispatch/testing/world.js";
import type { EnvironmentFacts, FilesystemDetector } from "../environment/index.js";
import { promoteController, readWorkersHold, writeFencedRecoveryManifest } from "../recovery/index.js";
import { RemoteWorkerClient, WorkerRequestError, type RemoteAttempt } from "../remote/client.js";
import { PROTOCOL_HEADER, SESSION_HEADER } from "../remote/protocol.js";
import { FULL_ABILITIES } from "../remote/testing/suite.js";
import { SqliteStorage } from "../storage/index.js";
import { storeDigest } from "../storage/sqlite/testing/raw-db.js";
import { startController, type Controller } from "./index.js";

// Card G08, the recovery-policy exercise: the policy K05 selected (a promotion made by the operator, no automatic failover: the old controller is fenced in the store first, the successor holds the workers until each is reconciled, and the
// owner decides whether a worker takes its attempt up again) run through the production code with the OLD CONTROLLER STILL RUNNING beside the successor on the same SQLite file. A worker that keeps talking to the old controller tries every
// way an attempt's work is accepted (a renewal, a tool call that ends the work, a model call to record, a checkpoint, the result, its session's heartbeat), and the old controller itself tries to dispatch and admit. The proof that none of it
// is accepted comes from an observer outside the controller: a read-only connection of its own to the database file that hashes every row of every table of the store before and after (the controller's code is not asked). The successor
// refuses the old session (H09b's session fence), and the attempt is taken up again only under the successor's epoch, by the owner's decision.

const ext4: FilesystemDetector = async () => ({ type: "ext4", network: false });
const supported: EnvironmentFacts = { platform: "linux", arch: "x64", osRelease: "6.8.0-generic", nodeVersion: "22.19.0" };
const CAPS = { os: "linux", arch: "x64", harnesses: [{ name: "pi", version: "1.3.0" }], isolation: ["bubblewrap"], tools: [], workspaces: [] };
const AGENT = "agt-abcdefghijklmnopqrst";

const open = (d: string, holder?: string): Promise<Controller> => startController({
  storage: { kind: "sqlite", path: join(d, "c.sqlite") }, argv: [], env: {}, print: () => undefined, facts: supported, filesystem: ext4, features: [], harnesses: [PI], ...(holder === undefined ? {} : { holder }),
  // The tool bridge is composed, so a tool call that ends the work is a real way to have work accepted.
  tools: { runner: { run: async () => { throw new Error("no script call runs in this test"); } } as never, isLocalHost: () => false },
  dispatch: {
    timer: new ManualTimer(), manual: true,
    route: async () => ({ route: "localp/small", harness: "pi", role: "worker", request: { contextTokens: 1000, needs: [], data: "cloud-allowed", paidAuthorized: false } }),
    remote: { workspaceAdmission: async () => [], blobDirectory: join(d, "blobs"), hosts: [{ hostId: "host:r1", window: () => 131_072, checkpointWaitMs: 300, pollMs: 20, resources: { cpus: 1, memoryMb: 1024 }, requirements: () => ({ data: "cloud-allowed", harness: "pi" }) }] },
  },
} as never);

/** The outside observer: every row of every store table, hashed, on a read-only connection of its own (`storeDigest`). */
const digestOf = (d: string): { readonly digest: string; readonly rows: number } => storeDigest(join(d, "c.sqlite"));

async function admit(c: Controller, actor: string, projectId: string, n: string): Promise<{ taskId: string; attemptId: string }> {
  const taskId = (await c.services.projects.createTask({ commandId: `t${n}`, actor, projectId, title: `Order seeds ${n}` })).id;
  await c.services.projects.transitionTask({ commandId: `r${n}`, actor, taskId, expectedRevision: 1, to: "ready" });
  await c.services.assignments.assignTask({ commandId: `as${n}`, actor, taskId, owner: { kind: "agent", id: AGENT } });
  const a = (await c.services.assignments.getAssignment(taskId))!;
  const attemptId = (await c.services.assignments.admitAttempt({ commandId: `ad${n}`, actor: "inbox", taskId, expectedRevision: a.revision, generation: a.generation, owner: { kind: "agent", id: AGENT }, harness: "pi" })).id;
  return { taskId, attemptId };
}

/** A request with a session the client no longer holds (the worker's session with the old controller, presented to the successor). */
function rawPost(url: string, path: string, token: string, session: { readonly sessionId: string; readonly protocol: number }, body: object): Promise<{ status: number; code?: string }> {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(body);
    const req = httpRequest(new URL(path, url), { method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json", "content-length": String(Buffer.byteLength(data)), "idempotency-key": `g08-${Math.random()}`, [SESSION_HEADER]: session.sessionId, [PROTOCOL_HEADER]: String(session.protocol) } }, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (c: Buffer) => chunks.push(c));
      res.on("end", () => { let code: string | undefined; try { code = (JSON.parse(Buffer.concat(chunks).toString("utf8")) as { error?: { code?: string } }).error?.code; } catch { /* not JSON */ } resolve({ status: res.statusCode ?? 0, ...(code === undefined ? {} : { code }) }); });
    });
    req.on("error", reject);
    req.end(data);
  });
}

/** Every way the old controller could still accept work for the attempt, tried; each entry says what came back. "accepted" anywhere is a failure of the policy. */
async function oldPrimaryTries(old: Controller, client: RemoteWorkerClient, attempt: RemoteAttempt, order: WorkOrder, owner: string, project: string, round: string): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  const codeOf = (e: unknown): string => (e instanceof WorkerRequestError || (e as { code?: unknown })?.code !== undefined ? String((e as { code: unknown }).code) : `threw: ${String((e as Error)?.message ?? e).slice(0, 120)}`);
  const tryIt = async (what: string, fn: () => Promise<unknown>, accepted: (v: unknown) => boolean = () => true): Promise<void> => {
    try { const v = await fn(); out[what] = accepted(v) ? "accepted" : `refused in its answer: ${JSON.stringify(v).slice(0, 160)}`; } catch (e) { out[what] = codeOf(e); }
  };
  await tryIt("renewal", () => attempt.heartbeat());
  await tryIt("tool call ending the work", () => attempt.toolBridge(order.credential, { op: "work.end", callId: `g08-end-${round}`, args: { result: "done", note: "beans", report: "Beans planted." } } as never), (v) => (v as { ok?: unknown }).ok === true);
  await tryIt("model call recorded", () => attempt.streamTap({ batchMs: 0, batchChars: 0 }).started({ requestChars: 12 } as never), (v) => v !== undefined);
  await tryIt("checkpoint", () => attempt.putCheckpoint(1, { pi: { at: 1 } } as never));
  await tryIt("result", () => attempt.complete({ status: "completed", endKind: "normal" } as never));
  await tryIt("session heartbeat", () => client.heartbeat(100));
  await tryIt("dispatch tick", () => old.dispatch!.dispatcher.tick(), (v) => { const r = v as { started: unknown[]; adopted?: unknown[]; readmitted: unknown[]; lost: unknown[] }; return r.started.length + (r.adopted?.length ?? 0) + r.readmitted.length + r.lost.length > 0; });
  await tryIt("admission", () => admit(old, owner, project, `old-${round}`));
  return out;
}

/** Every try was refused because of the promotion: the epoch is stale, the session or attempt is fenced, or the dispatcher's identity is the successor's now. A refusal for any other reason would not show the fence. */
function refusedByTheFence(tries: Record<string, string>): void {
  for (const [what, answer] of Object.entries(tries)) assert.match(answer, /stale_epoch|\bfenced\b|no longer the primary|not the dispatcher/, `${what}: ${answer}`);
}

const dispatchOf = async (c: Controller, attemptId: string): Promise<DispatchBody | undefined> => (await c.storage.listAggregates("dispatch", { limit: 50 })).map((r) => r.body as unknown as DispatchBody).find((b) => b.attemptId === attemptId);

test("the selected recovery policy, with the old controller still running beside its successor: nothing the old primary or its worker does is accepted, as an outside reader of the database sees it; the old session is refused by the successor, and the attempt is taken up again only under the successor's epoch by the owner's decision (card G08)", async (t) => {
  const d = mkdtempSync(join(tmpdir(), "nn-g08-"));
  const old = await open(d);
  let successor: Controller | undefined;
  try {
    assert.ok(old.dispatch?.workerUrl !== undefined, old.dispatchProblem);
    const boot = await old.services.principals.bootstrapOwner({ name: "rob" });
    const rob = await old.services.principals.authenticate(boot.token);
    const project = (await old.services.projects.createProject({ commandId: "p1", actor: rob.id, name: "Garden" })).id;
    await old.services.principals.enroll(rob, { commandId: "e-r1", kind: "host", name: "r1", grants: [] });
    const hostToken = (await old.services.principals.issueCredential(rob, "host:r1")).token;
    await AdmissionService.withEpoch(old.storage, old.epoch).setCapacity({ commandId: "cap", actor: rob.id, host: "host:r1", capacity: { cpus: 8, memoryMb: 16_384 } });
    await old.services.principals.enroll(rob, { commandId: "e-ann", kind: "agent", name: AGENT, grants: [{ action: "attempt.work", project }, { action: "task.read", project }, { action: "effect.perform", project }, { action: "review.request", project }] });
    const { attemptId } = await admit(old, rob.id, project, "1");

    // the worker takes the attempt up from the old controller; a renewal and a read are accepted while it is the primary
    const client = new RemoteWorkerClient({ url: old.dispatch.workerUrl!, token: hostToken, workerVersion: "worker-9.1.0" });
    await client.connect(CAPS as never);
    await client.heartbeat(1);
    assert.ok((await old.dispatch.dispatcher.tick()).started.includes(attemptId));
    const offer = (await client.offers()).find((o) => o.order.attemptId === attemptId)!;
    const attempt = client.attempt(attemptId, offer.placement);
    await attempt.accept();
    assert.deepEqual(await attempt.honorContract(offer.order, FULL_ABILITIES), { ok: true });
    const granted = await attempt.heartbeat();
    assert.equal(typeof granted.leaseMs, "number", "a renewal is accepted before the promotion");
    const discovered = await attempt.toolBridge(offer.order.credential, { op: "tool.discover", callId: "g08-discover" } as never);
    assert.equal(discovered.ok, true, `the tool bridge answers the worker before the promotion: ${JSON.stringify(discovered)}`);
    // The owner had let reconnected workers take their attempts up again by themselves: after a promotion the hold still makes them wait for the owner (K05 clause 3), so this does not decide the outcome below.
    const setting = await old.api.handle(boot.token, { v: 1, op: "reconnect.settings.set", commandId: "auto-1", args: { reaccept: "auto" } } as never) as { ok: boolean };
    assert.ok(setting.ok, JSON.stringify(setting));
    const oldSession = client.session!;
    const oldEpoch = old.epoch;

    // the operator promotes on another handle, as a recovery would; the old controller keeps running
    const other = await SqliteStorage.open({ path: join(d, "c.sqlite") });
    try {
      await writeFencedRecoveryManifest({ storage: other, epoch: oldEpoch, directory: join(d, "recovery"), now: () => new Date("2026-11-27T12:00:00.000Z") });
      const r = await promoteController({ storage: other, manifestDirectory: join(d, "recovery"), blobs: await FileBlobStore.open({ directory: join(d, "blobs") }), successor: "controller-b", promotionId: "g08", now: () => new Date("2026-11-27T12:05:00.000Z") });
      assert.equal(r.fencedHolder, "controller");
    } finally { await other.close(); }

    // 1. before the successor starts: the old primary and its worker try everything; the store does not change
    const before = digestOf(d);
    const first = await oldPrimaryTries(old, client, attempt, offer.order, rob.id, project, "1");
    assert.deepEqual(Object.entries(first).filter(([, v]) => v === "accepted"), [], JSON.stringify(first));
    refusedByTheFence(first);
    assert.equal(first["renewal"], "stale_epoch", "a renewal from the fenced epoch is refused");
    assert.deepEqual(digestOf(d), before, `nothing the old primary did reached the store: ${JSON.stringify(first)}`);

    // 2. the successor starts while the old controller still runs; once it is idle the store holds still, and the old primary's tries change nothing again
    successor = await open(d, "controller-b");
    assert.ok(successor.epoch > oldEpoch);
    const hold = await readWorkersHold(successor.storage);
    assert.ok(hold !== undefined && hold !== "unreadable" && hold.state === "held" && hold.attempts.some((a) => a.attemptId === attemptId), JSON.stringify(hold));
    const idle = digestOf(d);
    await new Promise((r) => setTimeout(r, 300));
    assert.deepEqual(digestOf(d), idle, "the idle successor writes nothing by itself (the observer's control)");
    const second = await oldPrimaryTries(old, client, attempt, offer.order, rob.id, project, "2");
    assert.deepEqual(Object.entries(second).filter(([, v]) => v === "accepted"), [], JSON.stringify(second));
    refusedByTheFence(second);
    assert.deepEqual(digestOf(d), idle, `nothing the old primary did reached the store with its successor running: ${JSON.stringify(second)}`);

    // 3. the worker's old session, presented to the successor, is refused for a renewal and for a result (H09b's session fence)
    const staleRenewal = await rawPost(successor.dispatch!.workerUrl!, `/worker/attempts/${attemptId}/heartbeat`, hostToken, oldSession, { placement: offer.placement });
    const staleResult = await rawPost(successor.dispatch!.workerUrl!, `/worker/attempts/${attemptId}/complete`, hostToken, oldSession, { placement: offer.placement, result: { status: "completed", endKind: "normal" } });
    assert.deepEqual([staleRenewal, staleResult], [{ status: 409, code: "fenced" }, { status: 409, code: "fenced" }]);
    assert.deepEqual(digestOf(d), idle, "the old session's renewal and result changed nothing");
    t.diagnostic(`G08 old primary, before the successor: ${JSON.stringify(first)}; beside it: ${JSON.stringify(second)}; old session at the successor: ${JSON.stringify({ staleRenewal, staleResult })}; store rows ${idle.rows}`);

    // 4. the policy's way back: the worker reconnects to the successor and waits; the owner decides; only then is the attempt's work accepted, under the successor's epoch
    const moved = new RemoteWorkerClient({ url: successor.dispatch!.workerUrl!, token: hostToken, workerVersion: "worker-9.1.0" });
    await moved.connect(CAPS as never);
    await moved.heartbeat(2);
    const handshake = await moved.reconcile([{ attemptId, placement: offer.placement }]);
    assert.notEqual(handshake.verdicts[0]!.verdict, "reaccept", JSON.stringify(handshake));
    const again = moved.attempt(attemptId, offer.placement);
    await assert.rejects(() => again.accept(), (e: unknown) => e instanceof WorkerRequestError && e.waitingForOwner);
    const next = await admit(successor, rob.id, project, "2");
    const tick = await successor.dispatch!.dispatcher.tick();
    assert.deepEqual(tick.started, [], "nothing starts while the workers are held");
    assert.ok(tick.skipped.some((x) => x.attemptId === next.attemptId && /stay stopped until they are reconciled/.test(x.reason)), JSON.stringify(tick.skipped));
    const call = async (op: string, args: Record<string, unknown>, commandId?: string): Promise<{ ok: boolean; result?: any }> => successor!.api.handle(boot.token, { v: 1, op, ...(commandId === undefined ? {} : { commandId }), args } as never) as never;
    const item = (await call("reconnect.pending", {})).result.items.find((x: { attemptId: string }) => x.attemptId === attemptId);
    assert.ok((await call("reconnect.reaccept", { attemptId, placement: offer.placement, sessionId: item.sessionId, waitingSince: item.at, decision: "approve" }, "ok-1")).ok);
    await successor.dispatch!.dispatcher.tick();
    assert.equal((await again.accept()).placement, offer.placement);
    await again.heartbeat();
    await again.complete({ status: "completed", endKind: "normal" } as never);
    await successor.dispatch!.dispatcher.idle();
    const ended = (await dispatchOf(successor, attemptId))!;
    assert.deepEqual([ended.state, ended.outcome?.status, ended.primaryEpoch], ["finished", "succeeded", successor.epoch], "the work was accepted by the successor, under its epoch");

    // 5. and afterwards the old primary still cannot add anything
    const after = digestOf(d);
    const third = await oldPrimaryTries(old, client, attempt, offer.order, rob.id, project, "3");
    assert.deepEqual(Object.entries(third).filter(([, v]) => v === "accepted"), [], JSON.stringify(third));
    refusedByTheFence(third);
    assert.deepEqual(digestOf(d), after);
  } finally { await successor?.close().catch(() => undefined); await old.close().catch(() => undefined); rmSync(d, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }); }
});
