import assert from "node:assert/strict";
import { commitOperation } from "../commit.js";
import { StorageError } from "../errors.js";
import type { ControllerStorage, OperationInput } from "../types.js";

/**
 * Crash qualification: "crash at every atomic boundary". One operation touches every part of the contract (aggregate create,
 * update and check; audit; outbox with ordering keys; a new effect and timer; a cancelled timer; a receipt, a timer firing and
 * an effect settlement). The writer is killed immediately before and immediately after each numbered statement of its
 * transaction. After every kill, what a fresh connection sees must be exactly the state before the operation or exactly the
 * state after it, never anything between, and the operation must become durable exactly when COMMIT has executed; resubmitting
 * it by its stable ID must then leave the state identical to a run that was never interrupted, admitting it once.
 */

const T0 = "2026-10-19T12:00:00.000Z";
const LATER = "2026-10-19T12:05:00.000Z";
const DIGEST = "0".repeat(64);

/** Puts the world in a known state: aggregates, a claimed delivery, a claimed timer, a pending timer, an intended effect. */
export async function seedWorld(storage: ControllerStorage): Promise<void> {
  await storage.acquireEpoch({ holder: "controller", at: T0 });
  await storage.applyOperation({
    operationId: "seed-op", epoch: 1, actor: "seeder", correlationId: "seed", at: T0,
    changes: [
      { type: "create", ref: { kind: "item", id: "t1" }, body: { state: "running" } },
      { type: "create", ref: { kind: "item", id: "t3" }, body: {} },
      { type: "create", ref: { kind: "grp", id: "g1" }, body: {} },
    ],
    audit: [{ type: "seed", detail: {} }],
    outbox: [
      { deliveryId: "d0", destination: "x", orderingKey: "k1", priority: 5, aggregate: { kind: "item", id: "t1" }, payload: { n: 0 } },
      { deliveryId: "c1", destination: "z", priority: 5, aggregate: { kind: "item", id: "t3" }, payload: { n: 0 } },
    ],
    effects: [{ effectId: "e0", target: "repo:main", inputDigest: DIGEST }],
    timers: [{ timerId: "tm0", dueAt: T0, payload: {} }, { timerId: "tm1", dueAt: T0, payload: {} }],
    cancelTimers: [], completeDeliveries: [], completeTimers: [], settleEffects: [],
  });
  const claimed = await storage.claimDeliveries({ epoch: 1, destination: "x", claimant: "w", now: T0, leaseMs: 3_600_000, limit: 1 });
  assert.equal(claimed[0]?.claimToken, "d0#1");
  const timers = await storage.claimDueTimers({ epoch: 1, claimant: "w", now: T0, leaseMs: 3_600_000, limit: 1 });
  assert.equal(timers[0]?.claimToken, "tm0#1");
}

/** The operation under test. */
export function richOperation(): OperationInput {
  return {
    operationId: "rich", epoch: 1, actor: "handler", correlationId: "corr-rich", at: LATER,
    changes: [
      { type: "update", ref: { kind: "item", id: "t1" }, expectedRevision: 1, body: { state: "done" } },
      { type: "create", ref: { kind: "item", id: "t2" }, body: { state: "new" } },
      { type: "check", ref: { kind: "grp", id: "g1" }, expectedRevision: 1 },
    ],
    audit: [{ type: "task.done", subject: { kind: "item", id: "t1" }, detail: { by: "handler" } }, { type: "task.created", subject: { kind: "item", id: "t2" }, detail: {} }],
    outbox: [
      { deliveryId: "n1", destination: "x", orderingKey: "k1", priority: 5, aggregate: { kind: "item", id: "t1" }, payload: { n: 1 } },
      { deliveryId: "n2", destination: "y", priority: 9, aggregate: { kind: "item", id: "t2" }, payload: { n: 2 } },
    ],
    effects: [{ effectId: "e1", attemptId: "a1", target: "repo:main", inputDigest: DIGEST, reconciliationHandle: "h1" }],
    timers: [{ timerId: "tm9", dueAt: "2026-10-19T13:00:00.000Z", aggregate: { kind: "item", id: "t2" }, payload: { kind: "deadline" } }],
    cancelTimers: ["tm1"],
    completeDeliveries: [{ deliveryId: "d0", claimToken: "d0#1", receipt: { ok: true } }],
    completeTimers: [{ timerId: "tm0", claimToken: "tm0#1" }],
    settleEffects: [{ effectId: "e0", outcome: "confirmed", evidence: { sha: "abc" } }],
  };
}

/** Everything observable, as plain JSON, for exact comparison. */
export async function snapshotWorld(storage: ControllerStorage): Promise<unknown> {
  const all = async <T>(ids: string[], read: (id: string) => Promise<T | undefined>) => Promise.all(ids.map(read));
  return JSON.parse(JSON.stringify({
    epoch: await storage.currentEpoch(),
    items: await storage.listAggregates("item", { limit: 100 }),
    groups: await storage.listAggregates("grp", { limit: 100 }),
    audit: await storage.listAudit({ afterSeq: 0, limit: 100 }),
    deliveries: await all(["d0", "c1", "n1", "n2"], (id) => storage.getDelivery(id)),
    effects: await all(["e0", "e1"], (id) => storage.getEffect(id)),
    timers: await all(["tm0", "tm1", "tm9"], (id) => storage.getTimer(id)),
    operations: await all(["seed-op", "rich"], (id) => storage.getOperation(id)),
  }));
}

export interface CrashPoint { readonly when: "before" | "after"; readonly ordinal: number }
export interface AttemptEnd {
  /** Numbered statements the transaction ran (BEGIN is 1; COMMIT is last). Only meaningful for an uninterrupted attempt. */
  readonly statements: number;
  /** True if the attempt was cut short by the injected crash. */
  readonly crashed: boolean;
}

/**
 * One write path of the storage, swept by the crash matrix. `run` performs it; `rerun` is what a caller does after a crash to
 * bring the world to the same final state whether or not the first attempt committed (resubmit by ID; a refused repeat of an
 * already applied claim, takeover or retry is the expected answer and is swallowed).
 */
export interface BoundaryAction {
  readonly name: "operation" | "claim" | "epoch" | "retry";
  run(storage: ControllerStorage): Promise<unknown>;
  rerun(storage: ControllerStorage): Promise<unknown>;
}

const swallow = async (kinds: readonly string[], call: () => Promise<unknown>): Promise<void> => {
  try { await call(); } catch (error) { if (!(error instanceof StorageError) || !kinds.includes(error.kind)) throw error; }
};

export const ACTIONS: Record<BoundaryAction["name"], BoundaryAction> = {
  operation: { name: "operation", run: (s) => s.applyOperation(richOperation()), rerun: (s) => commitOperation(s, richOperation()) },
  claim: {
    name: "claim",
    run: (s) => s.claimDeliveries({ epoch: 1, destination: "z", claimant: "w", now: LATER, leaseMs: 3_600_000, limit: 5 }),
    rerun: (s) => s.claimDeliveries({ epoch: 1, destination: "z", claimant: "w", now: LATER, leaseMs: 3_600_000, limit: 5 }),
  },
  epoch: {
    name: "epoch",
    run: (s) => s.acquireEpoch({ holder: "second", at: LATER, expectedEpoch: 1 }),
    rerun: (s) => swallow(["stale_epoch"], () => s.acquireEpoch({ holder: "second", at: LATER, expectedEpoch: 1 })),
  },
  retry: {
    name: "retry",
    run: (s) => s.retryDelivery({ epoch: 1, deliveryId: "d0", claimToken: "d0#1", nextAttemptAt: "2026-10-19T14:00:00.000Z", reason: "boundary", at: LATER }),
    rerun: (s) => swallow(["state_conflict"], () => s.retryDelivery({ epoch: 1, deliveryId: "d0", claimToken: "d0#1", nextAttemptAt: "2026-10-19T14:00:00.000Z", reason: "boundary", at: LATER })),
  },
};

export interface BoundaryWorld {
  /** An ordinary, uninterrupted connection: for seeding, inspecting and resolving. */
  readonly view: ControllerStorage;
  /** Runs `action` on a connection that dies at `point` (or runs normally if `point` is undefined). */
  attempt(action: BoundaryAction["name"], point: CrashPoint | undefined): Promise<AttemptEnd>;
  close(): Promise<void>;
}

export interface BoundaryRig {
  readonly name: string;
  /** A fresh, empty, isolated world. */
  open(): Promise<BoundaryWorld>;
}

export interface BoundaryReport { readonly backend: string; readonly action: string; readonly statements: number; readonly points: number; readonly committedPoints: string[] }

/**
 * Runs the crash matrix for one action against one backend: kill before and after every statement of its transaction. After each
 * kill the state must be exactly the state before or exactly the state after an uninterrupted run, the action must be durable
 * exactly when COMMIT has executed, and re-running it as a caller would must end in the uninterrupted final state. Throws, naming
 * the crash point, on the first violation.
 */
export async function runBoundaryQualification(rig: BoundaryRig, name: BoundaryAction["name"] = "operation"): Promise<BoundaryReport> {
  const action = ACTIONS[name];
  const baseline = await rig.open();
  let before: unknown;
  let after: unknown;
  let statements: number;
  try {
    await seedWorld(baseline.view);
    before = await snapshotWorld(baseline.view);
    const clean = await baseline.attempt(name, undefined);
    assert.equal(clean.crashed, false);
    statements = clean.statements;
    after = await snapshotWorld(baseline.view);
  } finally {
    await baseline.close();
  }
  assert.notDeepEqual(before, after, "the action must change something");
  assert.ok(statements >= (name === "operation" ? 20 : 3), `the action is expected to run several statements, saw ${statements}`);

  const committedPoints: string[] = [];
  let points = 0;
  for (let ordinal = 1; ordinal <= statements; ordinal++) {
    for (const when of ["before", "after"] as const) {
      const label = `${rig.name}/${name}: crash ${when} statement ${ordinal} of ${statements}`;
      const world = await rig.open();
      try {
        await seedWorld(world.view);
        const end = await world.attempt(name, { when, ordinal });
        assert.equal(end.crashed, true, `${label}: the crash point was not reached`);
        points += 1;
        const seen = await snapshotWorld(world.view);
        const committed = JSON.stringify(seen) === JSON.stringify(after);
        const untouched = JSON.stringify(seen) === JSON.stringify(before);
        assert.ok(committed || untouched, `${label}: a partial result is visible`);
        // Durable exactly when COMMIT has executed: after the last statement, never before it.
        assert.equal(committed, ordinal === statements && when === "after", `${label}: expected ${ordinal === statements && when === "after" ? "committed" : "not committed"}`);
        if (committed) committedPoints.push(`${when} ${ordinal}`);
        if (name === "operation") {
          const resolved = await commitOperation(world.view, richOperation());
          assert.equal(resolved.replayed, committed, `${label}: resubmission ${committed ? "must be recognised as the same admission" : "must apply the operation"}`);
        } else {
          await action.rerun(world.view);
        }
        assert.deepEqual(await snapshotWorld(world.view), after, `${label}: after the caller's retry the state differs from an uninterrupted run`);
      } finally {
        await world.close();
      }
    }
  }
  return { backend: rig.name, action: name, statements, points, committedPoints };
}
