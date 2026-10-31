import assert from "node:assert/strict";
import { after, test } from "node:test";
import { backends, stopServer } from "../domain/testing/backends.js";
import { buildWorld, workGrants } from "./testing/world.js";

after(stopServer);

// The owner's aggregate spending cap through the dispatcher: real spend (reported by a worker and settled, or charged) counts toward it, and a closed budget is the owner's to hear about.
const backend = backends[0]!;
const setCap = (c: Awaited<ReturnType<typeof buildWorld>>, f: Record<string, unknown>) => c.budgets.setAggregate(c.owner, { commandId: `cap-${Math.random()}`, ...f } as never);

test("money a worker spends and the dispatcher settles counts toward the cap even though the cap never saw a reservation of it: the next attempt's reservation is refused and nothing more is spent", async () => {
  const store = await backend.open();
  try {
    const c = await buildWorld(store.storage);
    const ann = await c.agent("ann", workGrants(c.project, ["read-file"]));
    const first = await c.task("first", ann);
    await c.budgets.open(c.owner, { commandId: "bo1", taskId: first.taskId, currency: "USD", costMicros: 100_000 });
    await setCap(c, { enabled: true, scope: "installation", period: "none", amountMicros: 5_000 });
    c.worker.script = async ({ gateway }) => { await gateway.usage({ turnSeq: 1, costMicros: 6_000, computeMs: 10 }); return { status: "completed", text: "x" }; };
    c.dispatcher = c.restart({}, { reserveCostMicros: 1000 });
    await c.dispatcher.tick(); await c.dispatcher.idle();
    assert.equal(c.worker.starts.length, 1);
    assert.equal((await c.budgets.report(c.owner, first.taskId))!.spent.costMicros, 6_000, "the spend is recorded whatever the cap");
    // The cap is now reached: the gate in front of the next paid call says so, and the next reservation is refused.
    assert.match((await c.budgets.capReached(c.owner, { taskId: first.taskId, agentId: "agent:ann" }))!, /aggregate cap is reached.*6000 of 5000/);
    await c.heartbeatHost();
    const second = await c.task("second", ann);
    await c.budgets.open(c.owner, { commandId: "bo2", taskId: second.taskId, currency: "USD", costMicros: 100_000 });
    const report = await c.dispatcher.tick(); await c.dispatcher.idle();
    assert.equal(c.worker.starts.length, 1, "the second attempt did not start");
    assert.ok(report.skipped.some((s) => s.check === "budget" && /aggregate cap/.test(s.reason)), JSON.stringify(report.skipped));
    // Raising the cap lets it through again.
    await setCap(c, { amountMicros: 1_000_000 });
    assert.equal(await c.budgets.capReached(c.owner, { taskId: first.taskId, agentId: "agent:ann" }), undefined);
  } finally { await store.close(); }
});

test("a closed budget does not leave the attempt waiting in silence: the dispatcher opens a blocker naming it", async () => {
  const store = await backend.open();
  try {
    const c = await buildWorld(store.storage);
    const ann = await c.agent("ann", workGrants(c.project, ["read-file"]));
    const t = await c.task("t", ann);
    await c.budgets.open(c.owner, { commandId: "bo", taskId: t.taskId, currency: "USD", costMicros: 1000, computeMs: 3_600_000 });
    await c.budgets.close(c.owner, { commandId: "bc", taskId: t.taskId });
    const report = await c.dispatcher.tick(); await c.dispatcher.idle();
    assert.equal(c.worker.starts.length, 0);
    const blockers = (await c.storage.listAggregates("blocker", { limit: 100 })).map((a) => a.body as unknown as { type: string; summary: string });
    assert.ok(blockers.some((b) => b.type === "dispatch_blocked" && /is closed/.test(b.summary)), JSON.stringify({ blockers, skipped: report.skipped, blocked: report.blocked }));
    assert.equal(report.blocked.length >= 1 || blockers.length >= 1, true);
  } finally { await store.close(); }
});
