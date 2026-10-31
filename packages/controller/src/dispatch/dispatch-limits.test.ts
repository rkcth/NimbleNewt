import assert from "node:assert/strict";
import { after, test } from "node:test";
import { backends, stopServer } from "../domain/testing/backends.js";
import type { DispatcherLimitFigures } from "./dispatcher.js";
import { buildWorld, workGrants } from "./testing/world.js";

after(stopServer);

// The dispatcher's attempt time and attempt count are OFF unless something turns them on (owner setting, start-up option, configuration, contract). These tests drive the dispatcher with a long lease so that only the expiry ends an attempt.
const backend = backends[0]!;
const LONG_LEASE = 40 * 3_600_000;
const HOUR = 3_600_000;

async function world(options: Parameters<Awaited<ReturnType<typeof buildWorld>>["restart"]>[1]) {
  const store = await backend.open();
  const c = await buildWorld(store.storage);
  const ann = await c.agent("ann", workGrants(c.project, ["read-file"]));
  c.dispatcher = c.restart({}, { leaseMs: LONG_LEASE, ...options });
  c.worker.script = () => new Promise<never>(() => undefined); // a turn that never ends
  return { c, ann, store };
}
const stateOf = async (c: Awaited<ReturnType<typeof world>>["c"], attemptId: string) => (await c.assignments.getAttempt(attemptId))!.state;

test("by default an attempt has no time limit: past four hours (and ten) it is not abandoned, and no expiry is recorded", async () => {
  const { c, ann, store } = await world({});
  try {
    const { attemptId } = await c.task("t", ann);
    await c.dispatcher.tick();
    assert.equal(c.worker.starts.length, 1);
    assert.equal((await c.dispatcher.get(c.owner, attemptId!))!.expiresAt, undefined);
    for (const h of [5, 10]) {
      c.clock.advance(h === 5 ? 5 * HOUR : 5 * HOUR);
      const report = await c.dispatcher.tick();
      assert.deepEqual(report.lost, [], `at ${h} hours`);
      assert.equal(await stateOf(c, attemptId!), "active");
    }
  } finally { await store.close(); }
});

test("the time limit is read at each claim: on it ends an attempt past the limit, off again leaves the next attempt unlimited; a running attempt keeps the expiry it was given", async () => {
  let figures: DispatcherLimitFigures = { attemptMs: 4 * HOUR };
  const { c, ann, store } = await world({ limits: async () => figures });
  try {
    const first = await c.task("t1", ann);
    await c.dispatcher.tick();
    const recorded = (await c.dispatcher.get(c.owner, first.attemptId!))!;
    assert.equal(Date.parse(recorded.expiresAt!) - Date.parse(recorded.claimedAt), 4 * HOUR);
    figures = {}; // turned off while it runs: it keeps its expiry
    c.clock.advance(4 * HOUR + 1000);
    const report = await c.dispatcher.tick();
    assert.deepEqual(report.lost, [first.attemptId], "past its expiry the attempt is ended");
    assert.equal(await stateOf(c, first.attemptId!), "abandoned");
    // With the limit off the next task's attempt carries no expiry and survives a long time.
    await c.heartbeatHost();
    const second = await c.task("t2", ann);
    await c.dispatcher.tick();
    assert.equal((await c.dispatcher.get(c.owner, second.attemptId!))!.expiresAt, undefined);
    c.clock.advance(30 * HOUR);
    assert.deepEqual((await c.dispatcher.tick()).lost, []);
    // Turned on again: the next claim has an expiry.
    figures = { attemptMs: 10 * 60_000 };
    await c.heartbeatHost();
    const third = await c.task("t3", ann);
    await c.dispatcher.tick();
    const rec3 = (await c.dispatcher.get(c.owner, third.attemptId!))!;
    assert.equal(Date.parse(rec3.expiresAt!) - Date.parse(rec3.claimedAt), 10 * 60_000);
  } finally { await store.close(); }
});

test("the contract's maxMinutes and the configured time.maxMinutes shorten an attempt to the smallest of the figures set; none set, none applied", async () => {
  let configured: number | undefined = 30;
  const { c, ann, store } = await world({ limits: async () => ({ attemptMs: 4 * HOUR }), configuredMinutes: async () => configured });
  try {
    const a = await c.task("t1", ann);
    await c.dispatcher.tick();
    let rec = (await c.dispatcher.get(c.owner, a.attemptId!))!;
    assert.equal(Date.parse(rec.expiresAt!) - Date.parse(rec.claimedAt), 30 * 60_000, "configuration shortens the owner's four hours");
    await c.heartbeatHost();
    const b = await c.task("t2", ann);
    await c.contracts.setContract(c.owner, { commandId: "ct", taskId: b.taskId, expectedVersion: 0, budget: { maxMinutes: 10 } });
    await c.dispatcher.tick();
    rec = (await c.dispatcher.get(c.owner, b.attemptId!))!;
    assert.equal(Date.parse(rec.expiresAt!) - Date.parse(rec.claimedAt), 10 * 60_000, "the contract is shorter still");
    configured = undefined;
  } finally { await store.close(); }
  const alone = await world({ configuredMinutes: async () => undefined });
  try {
    const t = await alone.c.task("t", alone.ann);
    await alone.c.dispatcher.tick();
    assert.equal((await alone.c.dispatcher.get(alone.c.owner, t.attemptId!))!.expiresAt, undefined);
  } finally { await alone.store.close(); }
});

async function loseAttempts(c: Awaited<ReturnType<typeof world>>["c"], times: number): Promise<number> {
  let readmitted = 0;
  for (let i = 0; i < times; i++) {
    await c.heartbeatHost();
    await c.dispatcher.tick();
    c.clock.advance(LONG_LEASE + 1000); // the lease runs out
    readmitted += (await c.dispatcher.tick()).readmitted.length;
  }
  return readmitted;
}
const blockers = async (c: Awaited<ReturnType<typeof world>>["c"]) => (await c.storage.listAggregates("blocker", { limit: 100 })).map((a) => a.body as unknown as { type: string; summary: string });

test("by default there is no limit on attempts: five lost attempts are each replaced and no blocker names a count", async () => {
  const { c, ann, store } = await world({});
  try {
    await c.task("t", ann);
    assert.equal(await loseAttempts(c, 5), 5);
    assert.ok(!(await blockers(c)).some((b) => /attempts were made/.test(b.summary)));
  } finally { await store.close(); }
});

test("maxAttempts from the setting stops re-admission at that number; the contract's maxAttempts can only lower it, never lift it", async () => {
  let figures: DispatcherLimitFigures = { maxAttempts: 2 };
  const { c, ann, store } = await world({ limits: async () => figures });
  try {
    await c.task("t", ann);
    await loseAttempts(c, 3);
    assert.ok((await blockers(c)).some((b) => b.type === "dispatch_blocked" && /2 attempts were made and the task allows 2/.test(b.summary)));
  } finally { await store.close(); }
  figures = { maxAttempts: 2 };
  const w = await world({ limits: async () => figures });
  try {
    const t = await w.c.task("t", w.ann);
    await w.c.contracts.setContract(w.c.owner, { commandId: "ct", taskId: t.taskId, expectedVersion: 0, budget: { maxAttempts: 4 } });
    await loseAttempts(w.c, 3);
    assert.ok((await blockers(w.c)).some((b) => /2 attempts were made and the task allows 2/.test(b.summary)), "a contract cannot lift the owner's cap");
  } finally { await w.store.close(); }
});

test("a contract that allows fewer attempts than the owner's cap still wins (the smaller of the two)", async () => {
  const { c, ann, store } = await world({ limits: async () => ({ maxAttempts: 5 }) });
  try {
    const t = await c.task("t", ann);
    await c.contracts.setContract(c.owner, { commandId: "ct", taskId: t.taskId, expectedVersion: 0, budget: { maxAttempts: 1 } });
    await loseAttempts(c, 2);
    assert.ok((await blockers(c)).some((b) => /1 attempts were made and the task allows 1/.test(b.summary)));
  } finally { await store.close(); }
});

test("an attempt with no time limit holds a bounded slice of the task's compute (default four hours, settable), not the whole free allowance", async () => {
  for (const [options, held] of [[{}, 4 * HOUR], [{ computeReserveMs: HOUR }, HOUR]] as const) {
    const { c, ann, store } = await world(options);
    try {
      const t = await c.task("t", ann);
      await c.budgets.open(c.owner, { commandId: "bo", taskId: t.taskId, currency: "USD", costMicros: 10_000, computeMs: 100 * HOUR });
      await c.dispatcher.tick();
      assert.equal(c.worker.starts.length, 1);
      assert.equal((await c.budgets.report(c.owner, t.taskId))!.reservedInFlight.computeMs, held);
    } finally { await store.close(); }
  }
});

test("turning the attempt time on ends a running attempt that started without one once it has run that long, measured from its start; it is not replaced", async () => {
  let figures: DispatcherLimitFigures = {};
  const { c, ann, store } = await world({ limits: async () => figures });
  try {
    const { attemptId } = await c.task("t", ann);
    await c.dispatcher.tick();
    assert.equal((await c.dispatcher.get(c.owner, attemptId!))!.expiresAt, undefined);
    c.clock.advance(2 * HOUR);
    assert.deepEqual((await c.dispatcher.tick()).lost, [], "no cap yet");
    figures = { attemptMs: HOUR };
    const report = await c.dispatcher.tick();
    assert.deepEqual(report.lost, [attemptId], "two hours in, a one hour cap ends it");
    assert.deepEqual(report.readmitted, []);
    // A cap not yet reached leaves it alone.
  } finally { await store.close(); }
  figures = {};
  const w = await world({ limits: async () => figures });
  try {
    const { attemptId } = await w.c.task("t", w.ann);
    await w.c.dispatcher.tick();
    w.c.clock.advance(HOUR);
    figures = { attemptMs: 3 * HOUR };
    assert.deepEqual((await w.c.dispatcher.tick()).lost, []);
    assert.equal(await stateOf(w.c, attemptId!), "active");
  } finally { await w.store.close(); }
});

test("an unreadable limits setting while a lost attempt is being ended leaves it unfinished, so the replacement is not lost; the next tick ends it and re-admits", async () => {
  let broken = false;
  const { c, ann, store } = await world({ limits: async () => { if (broken) throw new Error("setting unreadable"); return {}; } });
  try {
    const { attemptId } = await c.task("t", ann);
    await c.dispatcher.tick();
    c.clock.advance(LONG_LEASE + 1000);
    broken = true;
    await c.dispatcher.tick().catch(() => undefined);
    assert.equal((await c.dispatcher.get(c.owner, attemptId!))!.state !== "finished", true, "not finished while the figures cannot be read");
    broken = false;
    await c.heartbeatHost();
    assert.equal((await c.dispatcher.tick()).readmitted.length, 1);
    assert.equal((await c.dispatcher.get(c.owner, attemptId!))!.state, "finished");
  } finally { await store.close(); }
});

test("a restarted controller lets go of the host's hold on a lost attempt it has no handle for", async () => {
  const { c, ann, store } = await world({});
  try {
    const { attemptId } = await c.task("t", ann);
    await c.dispatcher.tick();
    c.dispatcher = c.restart({}, { leaseMs: LONG_LEASE }); // the handle was in the old process
    c.clock.advance(LONG_LEASE + 1000);
    await c.dispatcher.tick();
    assert.deepEqual(c.worker.released.map((r) => r.attemptId), [attemptId]);
  } finally { await store.close(); }
});

test("the probe a host is asked about carries no expiry when the attempt has none (it is not stamped with the current time)", async () => {
  const { c, ann, store } = await world({});
  try {
    const probes: unknown[] = [];
    (c.worker as { refuses?: unknown }).refuses = async (probe: unknown) => { probes.push(probe); return { reasons: [], lasting: false }; };
    await c.task("t", ann);
    await c.dispatcher.tick();
    assert.equal(probes.length > 0, true);
    assert.equal("expiresAt" in (probes[0] as object), false);
  } finally { await store.close(); }
});
