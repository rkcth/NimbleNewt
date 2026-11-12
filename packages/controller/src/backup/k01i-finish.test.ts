import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { DomainError } from "../domain/errors.js";
import type { Principal } from "../security/principals.js";
import { MemoryStorage, SqliteStorage } from "../storage/index.js";
import { BackupService, MaintenanceBarrier, NamedWork, StagedRestore, stopAllWork } from "./index.js";

// Card K01i, the rest: the named barrier participants, the owner's stop of live work and what the restore plan and status say about them.
const AT = "2026-10-31T10:00:00.000Z";
const OWNER = { id: "owner:rob", kind: "owner", name: "rob", grants: [] } as unknown as Principal;
const tick = (): Promise<void> => new Promise((r) => setTimeout(r, 5));

test("NamedWork: a wrapped function does not start while its group is held, the hold waits for what is running and letting go starts it again; unwrapped groups hold with nothing to wait for (card K01i)", async () => {
  const work = new NamedWork();
  const log: string[] = [];
  let release!: () => void;
  const slow = work.wrap("slow", async (n: number) => { log.push(`start ${n}`); await new Promise<void>((r) => { release = r; }); log.push(`end ${n}`); return n * 2; });
  const quick = work.wrap("quick", (n: number) => { log.push(`quick ${n}`); return n; });
  const boom = work.wrap("boom", async () => { throw new Error("its own failure"); });
  assert.deepEqual([...work.names].sort(), ["boom", "quick", "slow"]);
  const running = slow(1);
  await tick();
  assert.equal(work.inFlight("slow"), 1);
  const barrier = new MaintenanceBarrier();
  barrier.add(work.participant("slow-things", ["slow", "never-wrapped"]));
  barrier.add(work.participant("quick-things", ["quick"]));
  let raised = false;
  const raising = barrier.raise("test").then((r) => { raised = true; return r; });
  await tick();
  assert.equal(raised, false, "the barrier waits for the run in flight");
  assert.equal(work.isHeld("slow"), true, "and the group is held meanwhile, so nothing new starts");
  assert.equal(await slow(2), undefined, "a held function returns without running");
  assert.deepEqual(log, ["start 1"]);
  release();
  assert.equal(await running, 2, "the run in flight finishes with its own result");
  const up = await raising;
  assert.equal(await quick(5), undefined);
  assert.deepEqual(log, ["start 1", "end 1"]);
  assert.equal(await boom().catch((e: Error) => e.message), "its own failure", "a group that is not held throws what it threw");
  await up();
  assert.equal(work.isHeld("slow"), false);
  assert.equal(await quick(6), 6);
  const again = slow(3); await tick(); release(); assert.equal(await again, 6);
  // A run that fails while the hold waits does not stop the barrier from coming up.
  const failing = work.wrap("failing", async () => { await tick(); throw new Error("late failure"); });
  const f = failing().catch(() => "failed");
  const b2 = new MaintenanceBarrier(); b2.add(work.participant("failing-things", ["failing"]));
  const up2 = await b2.raise("x");
  assert.equal(await f, "failed");
  await up2();
});

test("stopAllWork: a graceful Stop of the whole installation as the owner, waits until nothing is recorded as running, and says plainly when it does not settle (card K01i)", async () => {
  const calls: unknown[] = [];
  const stops = (phase: string) => ({ request: async (_by: Principal, c: unknown) => { calls.push(c); return { intentId: "stp-1", replayed: false }; }, advance: async () => ({ phase }) as never });
  await stopAllWork({ stops: stops("done"), by: OWNER, commandId: "c1", reason: "restoring x" });
  assert.deepEqual(calls[0], { commandId: "c1", scope: { kind: "installation", id: "installation" }, mode: "stop", reason: "restoring x" });
  await assert.rejects(stopAllWork({ stops: stops("blocked"), by: OWNER, commandId: "c2", reason: "r" }), (e: unknown) => e instanceof DomainError && e.code === "unavailable" && /did not settle.*blocked.*will not stop on its own.*stays paused/s.test(e.message));
  await assert.rejects(stopAllWork({ stops: stops("recovery-required"), by: OWNER, commandId: "c3", reason: "r" }), /recovery-required/);
  // The attempts' ends are recorded by the dispatcher's next ticks: they are driven until none runs, within the wait.
  let running = 3; let steps = 0;
  await stopAllWork({ stops: stops("done"), by: OWNER, commandId: "c4", reason: "r", settle: { settled: async () => running === 0, step: async () => { steps += 1; running -= 1; } } });
  assert.equal(steps, 3);
  await assert.rejects(stopAllWork({ stops: stops("done"), by: OWNER, commandId: "c5", reason: "r", settle: { settled: async () => false, step: async () => undefined, waitMs: 250 } }), /still recorded as running.*stays paused/s);
});

async function rig(extra: Partial<ConstructorParameters<typeof StagedRestore>[0]> = {}) {
  const d = mkdtempSync(join(tmpdir(), "nn-k01i-finish-"));
  const data = join(d, "data"); mkdirSync(data);
  const sqlite = join(data, "c.sqlite");
  const storage = await SqliteStorage.open({ path: sqlite });
  const { epoch } = await storage.acquireEpoch({ holder: "c1", at: AT });
  await storage.applyOperation({ operationId: "op-1", epoch, actor: "owner:rob", correlationId: "co-1", at: AT, changes: [{ type: "create", ref: { kind: "task", id: "task-a" }, body: { title: "x" } }], audit: [{ type: "task.created", detail: {} }], outbox: [], effects: [], timers: [], cancelTimers: [], completeDeliveries: [], completeTimers: [], settleEffects: [] } as never);
  const backups = new BackupService(storage, { root: join(d, "b"), version: "t", now: () => new Date(AT) });
  const made = await backups.backUpNow("manual");
  const barrier = new MaintenanceBarrier();
  barrier.add({ name: "backups", hold: async () => backups.hold() });
  const log: string[] = [];
  barrier.add({ name: "late", hold: async () => { log.push("barrier raised"); return () => undefined; } });
  const restore = new StagedRestore({ backups, root: join(d, "b"), barrier, sqlitePath: sqlite, dataDirectory: data, storage, now: () => new Date("2026-10-31T11:00:00.000Z"), ...extra });
  return { d, data, sqlite, storage, made, barrier, restore, log, close: async () => { await storage.close().catch(() => undefined); rmSync(d, { recursive: true, force: true }); } };
}

test("a restore that asks for stopAttempts: refused when this controller cannot stop work, when the value is not true or false or the owner is not known; the stop comes before the barrier and a stop that fails stages nothing (card K01i)", async () => {
  const r = await rig();
  try {
    const plan = await r.restore.preview(r.made.manifest.name);
    await assert.rejects(r.restore.apply(plan.name, plan.token, undefined, { stopAttempts: true, by: OWNER }), (e: unknown) => e instanceof DomainError && e.code === "unavailable" && /cannot stop agent work/.test(e.message));
    await assert.rejects(r.restore.apply(plan.name, plan.token, undefined, { stopAttempts: "yes" }), (e: unknown) => e instanceof DomainError && e.code === "invalid_command");
    assert.equal(r.barrier.held, false);
    assert.equal(existsSync(join(r.data, "pending-restore.json")), false);
  } finally { await r.close(); }

  const order: string[] = [];
  const r2 = await rig({ stopAttempts: async (by, reason) => { order.push(`stop by ${by.id}: ${reason}`); } });
  try {
    const plan = await r2.restore.preview(r2.made.manifest.name);
    await assert.rejects(r2.restore.apply(plan.name, plan.token, undefined, { stopAttempts: true }), (e: unknown) => e instanceof DomainError && e.code === "invalid_command" && /owner who asks must be known/.test(e.message));
    assert.deepEqual(order, []);
    // Without the option nothing is stopped.
    const plan1 = await r2.restore.preview(r2.made.manifest.name);
    await r2.restore.apply(plan1.name, plan1.token);
    assert.deepEqual(order, [], "a restore that did not ask does not stop work");
    await r2.restore.cancel();
    const plan2 = await r2.restore.preview(r2.made.manifest.name);
    await r2.restore.apply(plan2.name, plan2.token, undefined, { stopAttempts: true, by: OWNER });
    assert.deepEqual(order, [`stop by owner:rob: restoring ${r2.made.manifest.name}`]);
    assert.deepEqual(r2.log, ["barrier raised", "barrier raised"], "the barrier was raised after the stop, once per apply");
    await r2.restore.cancel();
  } finally { await r2.close(); }

  // A stop that does not settle refuses the restore, clears what was staged and leaves the barrier down.
  const r3 = await rig({ stopAttempts: async () => { throw new DomainError("unavailable", "agent work did not settle for the restore"); } });
  try {
    const plan = await r3.restore.preview(r3.made.manifest.name);
    await assert.rejects(r3.restore.apply(plan.name, plan.token, undefined, { stopAttempts: true, by: OWNER }), /did not settle/);
    assert.equal(r3.barrier.held, false);
    assert.deepEqual(r3.log, [], "the barrier was never raised");
    assert.equal(existsSync(join(r3.data, "pending-restore.json")), false);
    assert.deepEqual(readdirSync(r3.data).filter((n) => n.includes(".nn-staged-")), [], "nothing staged stays");
    const again = await r3.restore.preview(r3.made.manifest.name);
    assert.ok(again.token, "the owner can ask again");
  } finally { await r3.close(); }
});

test("the plan warns how many attempts run and how to stop them; the status says what is waiting for remote hosts (card K01i)", async () => {
  let running = 2;
  const r = await rig({ liveAttempts: async () => running, remotePiState: async () => ({ waiting: [{ hostId: "host:r1", stores: 2, reason: "busy" }], delivered: 1, note: "n" }) });
  try {
    let plan = await r.restore.preview(r.made.manifest.name);
    assert.ok(plan.warnings.some((w) => /^2 agent attempts are running now.*stopAttempts/.test(w)), plan.warnings.join("|"));
    running = 1; plan = await r.restore.preview(r.made.manifest.name);
    assert.ok(plan.warnings.some((w) => /^1 agent attempt is running now/.test(w)));
    running = 0; plan = await r.restore.preview(r.made.manifest.name);
    assert.ok(!plan.warnings.some((w) => /agent attempt/.test(w)), "nothing running: no warning");
    const status = await r.restore.status();
    assert.deepEqual(status.remotePiState, { waiting: [{ hostId: "host:r1", stores: 2, reason: "busy" }], delivered: 1, note: "n" });
  } finally { await r.close(); }
  const none = await rig();
  try { assert.equal((await none.restore.status()).remotePiState, undefined); } finally { await none.close(); }
  void MemoryStorage;
});
