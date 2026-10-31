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
    assert.equal(seen.length, 1);
    assert.equal(seen[0]!.attemptId, attemptId);
    assert.notEqual(seen[0]!.state, "active", "the attempt was already finished when the hook ran");
    assert.ok(errors.some((e) => /hook failed/.test(String(e))), "a failing hook is reported");
    assert.equal((await c.dispatcher.get(c.owner, attemptId!))!.state, "finished");
  } finally { await store.close(); }
});
