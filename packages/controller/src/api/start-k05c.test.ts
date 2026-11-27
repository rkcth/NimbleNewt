import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { AdmissionService } from "../admission/service.js";
import { FileBlobStore } from "../artifacts/index.js";
import { BudgetService } from "../budgets/index.js";
import { ScriptedInterpreter } from "../chat/index.js";
import type { DispatchBody } from "../dispatch/model.js";
import { ManualTimer } from "../dispatch/testing/timer.js";
import { PI } from "../dispatch/testing/world.js";
import { DomainError } from "../domain/errors.js";
import type { EnvironmentFacts, FilesystemDetector } from "../environment/index.js";
import { WorkersHoldGate, promoteController, readWorkersHold, writeFencedRecoveryManifest, type WorkersHold } from "../recovery/index.js";
import { RemoteWorkerClient, WorkerRequestError } from "../remote/client.js";
import { PLACEMENT_KIND, type PlacementBody } from "../remote/service.js";
import { FULL_ABILITIES } from "../remote/testing/suite.js";
import { SqliteStorage } from "../storage/index.js";
import { startController, type Controller } from "./index.js";

// Card K05, clause 3, through the composed controller: two controllers on one SQLite file and a remote worker. The old controller places an attempt; a promotion made on another handle fences it and names a
// successor. The successor's workers stay stopped until reconciled: no attempt starts, the reconnecting worker waits for the owner although the setting says to take attempts up again by themselves, a result the
// worker sent to the fenced controller is not taken as new work (it stays with the placement as evidence), and an offer the fenced controller made is not taken up. The owner reads the hold in the existing
// database_transfer view (no new interpreter text) and decides with the existing reconnect.reaccept; the hold is released from those recorded facts and survives a restart.

const ext4: FilesystemDetector = async () => ({ type: "ext4", network: false });
const supported: EnvironmentFacts = { platform: "linux", arch: "x64", osRelease: "6.8.0-generic", nodeVersion: "22.19.0" };
const CAPS = { os: "linux", arch: "x64", harnesses: [{ name: "pi", version: "1.3.0" }], isolation: ["bubblewrap"], tools: [], workspaces: [] };
const AGENT = "agt-abcdefghijklmnopqrst";
const say: Record<string, unknown[]> = {};

const open = (d: string, holder?: string, clock?: () => string): Promise<Controller> => startController({
  storage: { kind: "sqlite", path: join(d, "c.sqlite") }, argv: [], env: {}, print: () => undefined, facts: supported, filesystem: ext4, features: [], harnesses: [PI], ...(holder === undefined ? {} : { holder }),
  chat: { interpreter: new ScriptedInterpreter((input) => say[input.text] ?? []) },
  dispatch: {
    timer: new ManualTimer(), manual: true, ...(clock === undefined ? {} : { clock }),
    route: async () => ({ route: "localp/small", harness: "pi", role: "worker", request: { contextTokens: 1000, needs: [], data: "cloud-allowed", paidAuthorized: false } }),
    remote: { workspaceAdmission: async () => [], blobDirectory: join(d, "blobs"), hosts: [{ hostId: "host:r1", window: () => 131_072, checkpointWaitMs: 300, pollMs: 20, resources: { cpus: 1, memoryMb: 1024 }, requirements: () => ({ data: "cloud-allowed", harness: "pi" }) }] },
  },
} as never);

interface Setup { readonly ownerToken: string; readonly hostToken: string; readonly project: string; readonly attemptId: string; readonly taskId: string }

async function setup(c: Controller): Promise<Setup> {
  const boot = await c.services.principals.bootstrapOwner({ name: "rob" });
  const rob = await c.services.principals.authenticate(boot.token);
  const project = (await c.services.projects.createProject({ commandId: "p1", actor: rob.id, name: "Garden" })).id;
  await c.services.principals.enroll(rob, { commandId: "e-r1", kind: "host", name: "r1", grants: [] });
  const hostToken = (await c.services.principals.issueCredential(rob, "host:r1")).token;
  await AdmissionService.withEpoch(c.storage, c.epoch).setCapacity({ commandId: "cap", actor: rob.id, host: "host:r1", capacity: { cpus: 8, memoryMb: 16_384 } });
  await c.services.principals.enroll(rob, { commandId: "e-ann", kind: "agent", name: AGENT, grants: [{ action: "attempt.work", project }, { action: "task.read", project }, { action: "effect.perform", project }, { action: "review.request", project }] });
  const { taskId, attemptId } = await admit(c, rob.id, project, "1");
  return { ownerToken: boot.token, hostToken, project, attemptId, taskId };
}

async function admit(c: Controller, actor: string, projectId: string, n: string): Promise<{ taskId: string; attemptId: string }> {
  const taskId = (await c.services.projects.createTask({ commandId: `t${n}`, actor, projectId, title: `Order seeds ${n}` })).id;
  await c.services.projects.transitionTask({ commandId: `r${n}`, actor, taskId, expectedRevision: 1, to: "ready" });
  await c.services.assignments.assignTask({ commandId: `as${n}`, actor, taskId, owner: { kind: "agent", id: AGENT } });
  const a = (await c.services.assignments.getAssignment(taskId))!;
  const attemptId = (await c.services.assignments.admitAttempt({ commandId: `ad${n}`, actor: "inbox", taskId, expectedRevision: a.revision, generation: a.generation, owner: { kind: "agent", id: AGENT }, harness: "pi" })).id;
  return { taskId, attemptId };
}

async function connect(c: Controller, s: Setup, beat: number): Promise<RemoteWorkerClient> {
  const client = new RemoteWorkerClient({ url: c.dispatch!.workerUrl!, token: s.hostToken, workerVersion: "worker-9.1.0" });
  await client.connect(CAPS as never);
  await client.heartbeat(beat);
  return client;
}

/** The worker takes the attempt the controller offers it (accepted, its contract confirmed). */
async function placed(c: Controller, s: Setup) {
  const client = await connect(c, s, 1);
  const report = await c.dispatch!.dispatcher.tick();
  assert.ok(report.started.includes(s.attemptId), JSON.stringify({ s: report.skipped, f: report.failures }));
  const offer = (await client.offers()).find((o) => o.order.attemptId === s.attemptId)!;
  const attempt = client.attempt(s.attemptId, offer.placement);
  await attempt.accept();
  assert.deepEqual(await attempt.honorContract(offer.order, FULL_ABILITIES), { ok: true });
  return { client, attempt, placement: offer.placement };
}

/** The promotion, run on another handle of the same file as a recovery operator would: the old controller's manifest first, then the fence and the successor. */
async function promote(d: string, oldEpoch: number, id: string): Promise<void> {
  const other = await SqliteStorage.open({ path: join(d, "c.sqlite") });
  try {
    await writeFencedRecoveryManifest({ storage: other, epoch: oldEpoch, directory: join(d, "recovery"), now: () => new Date("2026-11-27T12:00:00.000Z") });
    const r = await promoteController({ storage: other, manifestDirectory: join(d, "recovery"), blobs: await FileBlobStore.open({ directory: join(d, "blobs") }), successor: "controller-b", promotionId: id, now: () => new Date("2026-11-27T12:05:00.000Z") });
    assert.equal(r.fencedHolder, "controller");
  } finally { await other.close(); }
}

const dispatchOf = async (c: Controller, attemptId: string): Promise<DispatchBody | undefined> => (await c.storage.listAggregates("dispatch", { limit: 50 })).map((r) => r.body as unknown as DispatchBody).find((b) => b.attemptId === attemptId);
const placementOf = async (c: Controller, attemptId: string): Promise<PlacementBody> => (await c.storage.getAggregate({ kind: PLACEMENT_KIND, id: attemptId }))!.body as unknown as PlacementBody;
const holdOf = async (c: Controller): Promise<WorkersHold> => { const h = await readWorkersHold(c.storage); assert.ok(h !== undefined && h !== "unreadable", String(h)); return h; };
const call = async (c: Controller, token: string, op: string, args: Record<string, unknown>, commandId?: string): Promise<{ ok: boolean; result?: any; error?: { code: string; message: string } }> =>
  c.api.handle(token, { v: 1, op, ...(commandId === undefined ? {} : { commandId }), args } as never) as never;
const ask = async (c: Controller, token: string, id: string): Promise<string> => {
  const text = "are the workers still held after the promotion?";
  say[text] = [{ kind: "status", request: { kind: "database_transfer" }, evidence: text, basis: "owner" }];
  return JSON.stringify((await c.chat!.submit(token, { messageId: id, text })).outcomes);
};

test("after a promotion the successor's workers stay stopped until reconciled: nothing starts, the reconnected worker waits for the owner whatever the setting, the hold survives a restart and is released by the owner's decision (card K05)", async () => {
  const d = mkdtempSync(join(tmpdir(), "nn-k05c-"));
  const first = await open(d);
  let second: Controller | undefined;
  try {
    assert.ok(first.dispatch?.workerUrl !== undefined, first.dispatchProblem);
    const s = await setup(first);
    const { attempt, placement } = await placed(first, s);
    // the owner had let reconnected workers take their attempts up again by themselves
    assert.ok((await call(first, s.ownerToken, "reconnect.settings.set", { reaccept: "auto" }, "auto-1")).ok);
    await promote(d, first.epoch, "k05c");
    await assert.rejects(() => attempt.heartbeat(), (e: unknown) => e instanceof WorkerRequestError && e.code === "stale_epoch");
    await first.close();

    second = await open(d, "controller-b");
    let hold = await holdOf(second);
    assert.deepEqual([hold.state, hold.promotionId, hold.attempts.map((a) => [a.attemptId, a.hostId, a.placementState, a.storedResult]), hold.hosts.map((h) => h.hostId)], ["held", "k05c", [[s.attemptId, "host:r1", "accepted", false]], ["host:r1"]]);
    const rob = await second.services.principals.authenticate(s.ownerToken);
    const next = await admit(second, rob.id, s.project, "2");

    // a restart of the successor keeps the hold as it was
    const revision = (await second.storage.getAggregate({ kind: "recovery-workers-hold", id: "k05c" }))!.revision;
    await second.close();
    second = await open(d, "controller-b");
    assert.equal((await second.storage.getAggregate({ kind: "recovery-workers-hold", id: "k05c" }))!.revision, revision);

    // a takeover whose gate cannot be asked is held back (fail closed), and the run stays as it is
    const adoptAsked = WorkersHoldGate.prototype.adoptReason;
    WorkersHoldGate.prototype.adoptReason = async () => { throw new Error("the hold cannot be read just now"); };
    let tick: Awaited<ReturnType<NonNullable<Controller["dispatch"]>["dispatcher"]["tick"]>>;
    try { tick = await second.dispatch!.dispatcher.tick(); } finally { WorkersHoldGate.prototype.adoptReason = adoptAsked; }
    assert.deepEqual(tick.adopted, [], JSON.stringify(tick));
    assert.ok(tick.heldBack?.some((x) => x.attemptId === s.attemptId && /may be taken over could not be read/.test(x.reason)), JSON.stringify(tick.heldBack));
    assert.equal((await dispatchOf(second, s.attemptId))!.state, "running");

    // nothing starts while the hold stands; the accepted run is taken over (its worker still has to be told)
    tick = await second.dispatch!.dispatcher.tick();
    assert.ok(!tick.started.includes(next.attemptId), JSON.stringify(tick.started));
    assert.ok(tick.skipped.some((x) => x.attemptId === next.attemptId && /its workers stay stopped until they are reconciled: 1 worker host is not reconciled yet \(host:r1\)/.test(x.reason)), JSON.stringify(tick.skipped));
    assert.deepEqual(tick.adopted, [s.attemptId], JSON.stringify(tick));
    assert.equal(tick.loops.find((l) => l.name === "recovery.workers-hold")?.ok, true, JSON.stringify(tick.loops));
    assert.equal((await holdOf(second)).state, "held");

    // the owner reads it in the existing view
    const shown = await ask(second, s.ownerToken, "q1");
    assert.match(shown, /Workers held until reconciled since [^ ]+ \(promotion k05c\): no work starts\. 1 attempt of the fenced controller was running; 1 of 1 host is not reconciled yet\./, shown.slice(0, 1500));
    assert.ok(shown.includes(`host:r1: 1 attempt still open (${s.attemptId})`), shown.slice(0, 1500));
    assert.doesNotMatch(shown, new RegExp(d.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")), "no path in the answer");

    // the worker reconnects: under the setting it would take the attempt up by itself, but it waits for the owner
    const moved = await connect(second, s, 2);
    const handshake = await moved.reconcile([{ attemptId: s.attemptId, placement }]);
    assert.deepEqual([handshake.mode, handshake.verdicts[0]!.verdict], ["auto", "pending"], JSON.stringify(handshake));
    const again = moved.attempt(s.attemptId, placement);
    await assert.rejects(() => again.accept(), (e: unknown) => e instanceof WorkerRequestError && e.waitingForOwner);
    // a hold that cannot be asked about holds as well
    const asked = WorkersHoldGate.prototype.heldForReaccept;
    WorkersHoldGate.prototype.heldForReaccept = async () => { throw new Error("the hold cannot be read just now"); };
    try { await assert.rejects(() => again.accept(), (e: unknown) => e instanceof WorkerRequestError && e.waitingForOwner); } finally { WorkersHoldGate.prototype.heldForReaccept = asked; }
    tick = await second.dispatch!.dispatcher.tick();
    assert.ok(!tick.started.includes(next.attemptId));
    assert.equal((await holdOf(second)).state, "held");

    // the owner approves with the existing control: the host is reconciled, the hold released, work starts again
    const waiting = await call(second, s.ownerToken, "reconnect.pending", {});
    const item = waiting.result.items.find((x: { attemptId: string }) => x.attemptId === s.attemptId);
    assert.ok((await call(second, s.ownerToken, "reconnect.reaccept", { attemptId: s.attemptId, placement, sessionId: item.sessionId, waitingSince: item.at, decision: "approve" }, "ok-1")).ok);
    tick = await second.dispatch!.dispatcher.tick();
    hold = await holdOf(second);
    assert.deepEqual([hold.state, hold.attempts[0]!.resolved?.how, hold.hosts[0]!.reconnected], ["released", "taken-up", true], JSON.stringify(hold));
    tick = await second.dispatch!.dispatcher.tick();
    // no longer held by the promotion: the second attempt now waits only for its agent's store, which the taken-up attempt holds
    assert.ok(tick.skipped.some((x) => x.attemptId === next.attemptId && /native store .* is held by another attempt/.test(x.reason)) && !JSON.stringify(tick.skipped).includes("stay stopped"), JSON.stringify(tick.skipped));
    assert.equal((await again.accept()).placement, placement);
    await again.heartbeat();
    await again.complete({ status: "completed", endKind: "normal" } as never);
    await second.dispatch!.dispatcher.idle();
    assert.deepEqual([(await dispatchOf(second, s.attemptId))!.state, (await dispatchOf(second, s.attemptId))!.outcome?.status], ["finished", "succeeded"]);
    tick = await second.dispatch!.dispatcher.tick();
    assert.ok(tick.started.includes(next.attemptId), JSON.stringify({ s: tick.skipped, f: tick.failures }));
    const after = await ask(second, s.ownerToken, "q2");
    assert.match(after, /Workers after promotion k05c: 1 attempt of the fenced controller was running; all 1 host was reconciled and work started again at [^ ]+ \(0 ended, 1 taken up again with your approval\)\./, after.slice(0, 1500));
    // an agent is not shown the hold
    await second.services.principals.enroll(rob, { commandId: "e-zed", kind: "agent", name: "zed", grants: [] });
    const zed = (await second.services.principals.issueCredential(rob, "agent:zed")).token;
    assert.doesNotMatch(JSON.stringify(await call(second, zed, "status.ask", { request: { kind: "database_transfer" } })), /Workers/);
  } finally { await second?.close().catch(() => undefined); await first.close().catch(() => undefined); rmSync(d, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }); }
});

test("a result the worker sent to the fenced controller is not taken as new work: it stays with the placement as evidence, the attempt ends by its lease and a replacement starts once the hold is released (card K05)", async () => {
  const d = mkdtempSync(join(tmpdir(), "nn-k05c-"));
  const first = await open(d);
  let second: Controller | undefined;
  // The old controller charges the turn's figures, and the promotion fences it before it can end the attempt.
  const charge = BudgetService.prototype.charge;
  let armed = true;
  let fenced: () => void = () => undefined;
  const fencedP = new Promise<void>((resolve) => { fenced = resolve; });
  BudgetService.prototype.charge = async function (this: BudgetService, ...a: Parameters<BudgetService["charge"]>) {
    const r = await charge.apply(this, a);
    if (armed && a[1].activity === "model-call") { armed = false; await promote(d, first.epoch, "k05r"); fenced(); }
    return r;
  };
  try {
    const s = await setup(first);
    const { attempt } = await placed(first, s);
    await attempt.complete({ status: "completed", endKind: "normal", usage: { costMicros: 700 } } as never);
    await Promise.race([fencedP, new Promise<never>((_, reject) => { setTimeout(() => reject(new Error("the old controller never charged the turn")), 60_000).unref(); })]);
    await first.dispatch!.dispatcher.idle().catch(() => undefined);
    await first.close();

    // the successor's clock is past the old lease
    second = await open(d, "controller-b", () => new Date(Date.now() + 10 * 60_000).toISOString());
    assert.equal((await placementOf(second, s.attemptId)).state, "completed");
    const hold = await holdOf(second);
    assert.deepEqual(hold.attempts.map((a) => [a.attemptId, a.storedResult]), [[s.attemptId, true]]);
    const tick = await second.dispatch!.dispatcher.tick();
    await second.dispatch!.dispatcher.idle();
    assert.deepEqual(tick.adopted, [], JSON.stringify(tick));
    assert.ok(tick.heldBack?.some((x) => x.attemptId === s.attemptId && /kept as evidence/.test(x.reason)), JSON.stringify(tick.heldBack));
    assert.ok(tick.lost.includes(s.attemptId), JSON.stringify(tick));
    const ended = (await dispatchOf(second, s.attemptId))!;
    assert.deepEqual([ended.state, ended.outcome?.status], ["finished", "abandoned"], "the old result was not taken as this attempt's success");
    assert.notEqual((await placementOf(second, s.attemptId)).result, undefined, "the result stays with the placement as evidence");
    assert.equal(tick.readmitted.length, 1);
    assert.ok(!tick.started.includes(tick.readmitted[0]!), "the replacement waits for the hold");
    assert.equal((await holdOf(second)).state, "released");
    const shown = await ask(second, s.ownerToken, "q3");
    assert.match(shown, /1 result a worker sent to the fenced controller was not taken as new work; it is kept as evidence/, shown.slice(0, 1500));
    // released: a later tick starts the replacement on the reconnected worker
    await connect(second, s, 2);
    const later = await second.dispatch!.dispatcher.tick();
    assert.ok(later.started.includes(tick.readmitted[0]!), JSON.stringify({ s: later.skipped, f: later.failures }));
  } finally {
    BudgetService.prototype.charge = charge;
    await second?.close().catch(() => undefined); await first.close().catch(() => undefined); rmSync(d, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  }
});

test("an offer the fenced controller made is not taken up on the successor; the successor ends it as lost and starts a replacement only once the hold is released (card K05)", async () => {
  const d = mkdtempSync(join(tmpdir(), "nn-k05c-"));
  const first = await open(d);
  let second: Controller | undefined;
  try {
    const s = await setup(first);
    const client = await connect(first, s, 1);
    assert.ok((await first.dispatch!.dispatcher.tick()).started.includes(s.attemptId));
    const offer = (await client.offers()).find((o) => o.order.attemptId === s.attemptId)!;
    assert.equal((await placementOf(first, s.attemptId)).state, "offered");
    await promote(d, first.epoch, "k05o");
    await first.close();
    second = await open(d, "controller-b");
    assert.deepEqual((await holdOf(second)).attempts.map((a) => [a.attemptId, a.placementState]), [[s.attemptId, "offered"]]);
    // the worker kept the order and tries to take it up with the successor
    const moved = await connect(second, s, 2);
    await assert.rejects(() => moved.attempt(s.attemptId, offer.placement).accept(), (e: unknown) => (e instanceof WorkerRequestError || e instanceof DomainError) && e.code === "fenced" && /made by a controller that was fenced/.test(e.message));
    assert.equal((await placementOf(second, s.attemptId)).state, "offered");
    const tick = await second.dispatch!.dispatcher.tick();
    assert.ok(tick.lost.includes(s.attemptId), JSON.stringify(tick));
    assert.equal(tick.readmitted.length, 1);
    assert.ok(!tick.started.includes(tick.readmitted[0]!));
    assert.equal((await holdOf(second)).state, "released");
    assert.ok((await second.dispatch!.dispatcher.tick()).started.includes(tick.readmitted[0]!));
  } finally { await second?.close().catch(() => undefined); await first.close().catch(() => undefined); rmSync(d, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }); }
});
