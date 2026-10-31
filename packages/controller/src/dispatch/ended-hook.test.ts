import assert from "node:assert/strict";
import { after, test } from "node:test";
import { backends, stopServer } from "../domain/testing/backends.js";
import { buildWorld, workGrants } from "./testing/world.js";

after(stopServer);

const HOUR = 3_600_000;

test("the ended hook runs once the attempt is finished (never before), and a failing hook does not undo the end", async () => {
  const store = await backends[0]!.open();
  try {
    const c = await buildWorld(store.storage);
    const ann = await c.agent("ann", workGrants(c.project, ["read-file"]));
    const seen: { attemptId: string; state: string; outcome: string }[] = [];
    const errors: unknown[] = [];
    c.dispatcher = c.restart({}, { leaseMs: 40 * HOUR, limits: async () => ({ attemptMs: HOUR }), onError: (e: unknown) => { errors.push(e); } } as never);
    c.worker.script = () => new Promise<never>(() => undefined);
    c.dispatcher.onEnded(async (attemptId, how) => {
      seen.push({ attemptId, state: (await c.assignments.getAttempt(attemptId))!.state, outcome: how.outcome });
      throw new Error("hook failed");
    });
    const { attemptId } = await c.task("t", ann);
    await c.dispatcher.tick();
    assert.equal(seen.length, 0, "nothing while the attempt runs");
    c.clock.advance(2 * HOUR);
    await c.dispatcher.tick();
    await c.dispatcher.endedIdle();
    assert.equal(seen.length, 1);
    assert.equal(seen[0]!.attemptId, attemptId);
    assert.notEqual(seen[0]!.state, "active", "the attempt was already finished when the hook ran");
    assert.ok(errors.some((e) => /hook failed/.test(String(e))), "a failing hook is reported");
    assert.equal((await c.dispatcher.get(c.owner, attemptId!))!.state, "finished");
  } finally { await store.close(); }
});

test("a hook that hangs is cut off and never holds the end, idle() or the failure blocker; the hook is told whether the worker is confirmed stopped", async () => {
  const store = await backends[0]!.open();
  try {
    const c = await buildWorld(store.storage);
    const ann = await c.agent("ann", workGrants(c.project, ["read-file"]));
    const errors: unknown[] = [];
    c.dispatcher = c.restart({}, { leaseMs: 40 * HOUR, limits: async () => ({ attemptMs: HOUR }), endedHookMs: 30, onError: (e: unknown) => { errors.push(e); } } as never);
    c.worker.script = async ({ worker }) => { worker.stopError = new Error("sandbox would not die"); throw new Error("the worker broke"); };
    const told: { attemptId: string; workerStopped: boolean }[] = [];
    c.dispatcher.onEnded((attemptId, how) => { told.push({ attemptId, workerStopped: how.workerStopped }); return new Promise<void>(() => undefined); });
    const { attemptId } = await c.task("t", ann);
    await c.dispatcher.tick();
    await c.dispatcher.idle();
    assert.equal((await c.dispatcher.get(c.owner, attemptId!))!.state, "finished", "the attempt ended although the hook never answers");
    assert.equal((await c.dispatcher.get(c.owner, attemptId!) as unknown as { workerStopped?: boolean }).workerStopped, false, "a stop that failed is recorded as not confirmed");
    assert.deepEqual(told, [{ attemptId: attemptId!, workerStopped: false }]);
    const open = (await c.blockers.list({ limit: 50, openOnly: true })).items.filter((b) => b.type === "dispatch_blocked");
    assert.equal(open.length, 1, "the failure's blocker was opened without waiting for the hook");
    await c.dispatcher.endedIdle();
    assert.ok(errors.some((e) => /did not answer within 30 ms/.test(String(e))), "the hang is reported");
  } finally { await store.close(); }
});

test("a worker whose stop succeeded is recorded as confirmed stopped", async () => {
  const store = await backends[0]!.open();
  try {
    const c = await buildWorld(store.storage);
    const ann = await c.agent("ann", workGrants(c.project, ["read-file"]));
    c.dispatcher = c.restart({}, { leaseMs: 40 * HOUR, limits: async () => ({ attemptMs: HOUR }) } as never);
    c.worker.script = () => new Promise<never>(() => undefined);
    const told: boolean[] = [];
    c.dispatcher.onEnded(async (_id, how) => { told.push(how.workerStopped); });
    const { attemptId } = await c.task("t", ann);
    await c.dispatcher.tick();
    c.clock.advance(2 * HOUR);
    await c.dispatcher.tick();
    await c.dispatcher.endedIdle();
    assert.deepEqual(told, [true]);
    assert.equal((await c.dispatcher.get(c.owner, attemptId!) as unknown as { workerStopped?: boolean }).workerStopped, true);
  } finally { await store.close(); }
});
