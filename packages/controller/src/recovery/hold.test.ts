import assert from "node:assert/strict";
import { after, test } from "node:test";
import { backends, stopServer } from "../domain/testing/backends.js";
import { derivedId } from "../domain/ids.js";
import { DISPATCH_KIND, DISPATCH_LIVE } from "../dispatch/model.js";
import { PLACEMENT_KIND, SESSION_KIND } from "../remote/service.js";
import { workersHoldLines } from "../status/status.js";
import { MemoryStorage, type AggregateRef, type ControllerStorage, type JsonObject } from "../storage/index.js";
import { CONTROLLER_AUTHORITY, WORKERS_HOLD_KIND, WORKERS_HOLD_LIMITS, WorkersHoldGate, beginWorkersHold, parseWorkersHold, readWorkersHold, workersHoldGate, type WorkersHold } from "./index.js";
import { fenceHolder } from "./controller.js";

// Card K05, clause 3: after a controller promotion the successor's workers stay stopped until each host that held work of the fenced controller is reconciled. The hold is written once per promotion at the
// successor's start, lists the attempts that ran under the fenced epochs (kept as evidence), holds every start and the take-over of a result sent under a fenced epoch, makes a reconnecting worker wait for the
// owner whatever the setting says, and is released only by facts the store already records (the attempt is over, or it was taken up again in this controller's session after the owner approved). Every time is injected.

after(stopServer);
const T0 = "2026-11-27T12:00:00.000Z";
let clock = T0;
const now = (): string => clock;
let ops = 0;

async function put(storage: ControllerStorage, epoch: number, ref: AggregateRef, body: Record<string, unknown>): Promise<void> {
  const current = await storage.getAggregate(ref);
  await storage.applyOperation({
    operationId: `t-${ops++}`, epoch, actor: "test", correlationId: "t", at: T0,
    changes: [current === undefined ? { type: "create", ref, body: body as JsonObject } : { type: "update", ref, expectedRevision: current.revision, body: body as JsonObject }],
    audit: [], outbox: [], effects: [], timers: [], cancelTimers: [], completeDeliveries: [], completeTimers: [], settleEffects: [],
  });
}
const dispatchRef = (attemptId: string): AggregateRef => ({ kind: DISPATCH_KIND, id: derivedId("dpa", attemptId) });
const running = (attemptId: string, hostId: string, primaryEpoch?: number, extra: Record<string, unknown> = {}) => ({ attemptId, taskId: `task-${attemptId}`, hostId, state: "running", claimedAt: T0, heartbeats: 0, lease: { holder: "dispatcher", until: "2026-11-27T12:01:00.000Z" }, ...(primaryEpoch === undefined ? {} : { primaryEpoch }), ...extra });
const placement = (attemptId: string, hostId: string, state: string, extra: Record<string, unknown> = {}) => ({ attemptId, hostId, placement: 1, state, offeredAt: T0, history: [], ...extra });
const promoted = (promotionId: string, fencedEpoch: number, fenceEpoch: number) => ({ format: 1, promotionId, state: "promoted", successor: "ctl-b", fencedEpoch, fencedHolder: "ctl-a", fenceEpoch, at: T0 });

/** The old controller ran four attempts and claimed a fifth; a promotion fenced it; the successor starts. */
async function world(storage: ControllerStorage): Promise<{ old: number; fence: number; successor: number }> {
  const old = (await storage.acquireEpoch({ holder: "ctl-a", at: T0 })).epoch;
  await put(storage, old, DISPATCH_LIVE, { ids: ["att-a", "att-b", "att-c", "att-d", "att-o"] });
  await put(storage, old, dispatchRef("att-a"), running("att-a", "host:r1", old));
  await put(storage, old, placementRef("att-a"), placement("att-a", "host:r1", "accepted", { sessionId: "s-old-1", acceptedAt: T0, reaccept: { sessionId: "s-old-0", state: "auto", at: T0 } }));
  await put(storage, old, dispatchRef("att-b"), running("att-b", "local")); // no primaryEpoch: from before the field
  await put(storage, old, dispatchRef("att-c"), running("att-c", "host:r2", old));
  await put(storage, old, placementRef("att-c"), placement("att-c", "host:r2", "completed", { sessionId: "s-old-2", result: { status: "completed" } }));
  await put(storage, old, dispatchRef("att-d"), { ...running("att-d", "host:r1", old), state: "waiting" });
  await put(storage, old, dispatchRef("att-o"), running("att-o", "host:r2", old));
  await put(storage, old, placementRef("att-o"), placement("att-o", "host:r2", "offered"));
  const fence = (await storage.acquireEpoch({ holder: fenceHolder("p1", old, "ctl-a"), at: T0, expectedEpoch: old })).epoch;
  await put(storage, fence, CONTROLLER_AUTHORITY, promoted("p1", old, fence));
  const successor = (await storage.acquireEpoch({ holder: "ctl-b", at: T0, expectedEpoch: fence })).epoch;
  return { old, fence, successor };
}
const placementRef = (attemptId: string): AggregateRef => ({ kind: PLACEMENT_KIND, id: attemptId });
const holdOf = async (s: ControllerStorage): Promise<WorkersHold> => { const h = await readWorkersHold(s); assert.ok(h !== undefined && h !== "unreadable", String(h)); return h; };
const revisionOf = async (s: ControllerStorage): Promise<number | undefined> => (await s.getAggregate({ kind: WORKERS_HOLD_KIND, id: "p1" }))?.revision;
const text = (h: WorkersHold | "unreadable"): string => workersHoldLines(h, { kind: "installation", id: "installation" } as never).map((l) => (l as { text: string }).text).join("\n");

for (const backend of backends) {
  test(`${backend.name}: the successor's workers are held until each host is reconciled from recorded facts; starts, an old result and an automatic take-up are held; restart-safe; released once`, async () => {
    const w = await backend.open();
    try {
      clock = T0;
      const s = w.storage;
      const e = await world(s);
      // the successor's own attempt from an earlier run of it is not the fenced controller's
      await put(s, e.successor, DISPATCH_LIVE, { ids: ["att-a", "att-b", "att-c", "att-d", "att-o", "att-n"] });
      await put(s, e.successor, dispatchRef("att-n"), running("att-n", "host:r1", e.successor));

      const begun = await beginWorkersHold(s, e.successor, now);
      assert.ok(begun !== undefined && !("unreadable" in begun));
      const hold = begun as WorkersHold;
      assert.equal(hold.state, "held");
      assert.deepEqual(hold.attempts.map((a) => a.attemptId), ["att-a", "att-b", "att-c", "att-o"], "running attempts of the fenced epochs only: not the waiting one, not the successor's own");
      assert.deepEqual(hold.hosts.map((h) => [h.hostId, h.attempts]), [["host:r1", 1], ["host:r2", 2], ["local", 1]]);
      const a = hold.attempts.find((x) => x.attemptId === "att-a")!;
      assert.deepEqual([a.primaryEpoch, a.placement, a.placementState, [...a.sessions].sort(), a.storedResult, a.leaseUntil], [e.old, 1, "accepted", ["s-old-0", "s-old-1"], false, "2026-11-27T12:01:00.000Z"]);
      assert.equal(hold.attempts.find((x) => x.attemptId === "att-b")!.primaryEpoch, null);
      assert.equal(hold.attempts.find((x) => x.attemptId === "att-c")!.storedResult, true, "the result sent to the fenced controller is recorded as evidence");
      assert.deepEqual([hold.fencedEpoch, hold.fenceEpoch, hold.heldEpoch, hold.successor, hold.truncated], [e.old, e.fence, e.successor, "ctl-b", false]);
      const r0 = await revisionOf(s);
      // restart-safe: a second start neither begins it again nor changes it
      clock = "2026-11-27T12:00:30.000Z";
      assert.deepEqual(await beginWorkersHold(s, e.successor, now), hold);
      assert.equal(await revisionOf(s), r0);

      const gate = workersHoldGate(s, e.successor, hold, now);
      assert.match((await gate.startReason())!, /promotion p1\) and its workers stay stopped until they are reconciled: 3 worker hosts are not reconciled yet \(host:r1, host:r2, local\)/);
      assert.match((await gate.adoptReason({ attemptId: "att-c", primaryEpoch: e.old }))!, /result from the fenced controller's time; it is kept as evidence/);
      assert.match((await gate.adoptReason({ attemptId: "att-c" }))!, /kept as evidence/, "an attempt without an epoch counts as the fenced controller's");
      assert.equal(await gate.adoptReason({ attemptId: "att-c", primaryEpoch: e.successor }), undefined, "this controller's own epoch is not held");
      assert.equal(await gate.adoptReason({ attemptId: "att-a", primaryEpoch: e.old }), undefined, "a run its worker accepted may be taken over: its worker still waits for the owner");
      assert.equal(await gate.heldForReaccept("att-a"), true);
      assert.equal(await gate.heldForReaccept("att-o"), true);
      assert.equal(await gate.heldForReaccept("att-n"), false);
      assert.match(text(hold), /Workers held until reconciled since 2026-11-27T12:00:00.000Z \(promotion p1\): no work starts\. 4 attempts of the fenced controller were running; 3 of 3 hosts are not reconciled yet\./);
      assert.match(text(hold), /host:r2: 2 attempts still open \(att-c, att-o\)/);
      assert.match(text(hold), /1 result a worker sent to the fenced controller was not taken as new work; it is kept as evidence/);

      // nothing has changed: a review writes nothing
      assert.equal((await gate.review())!.state, "held");
      assert.equal(await revisionOf(s), r0);

      // facts that do not reconcile: approved for an old session, by the setting only, another placement, another host, an accepted placement under an old session
      for (const p of [
        placement("att-a", "host:r1", "accepted", { sessionId: "s-old-1", reaccept: { sessionId: "s-old-0", state: "approved", at: T0, by: "rob" } }),
        placement("att-a", "host:r1", "accepted", { sessionId: "s-old-1", reaccept: { sessionId: "s-new", state: "auto", at: T0 } }),
        placement("att-a", "host:r1", "accepted", { sessionId: "s-old-1", reaccept: { sessionId: "s-new", state: "pending", at: T0 } }),
        placement("att-a", "host:r1", "accepted", { sessionId: "s-old-1", reaccept: { sessionId: "s-new", state: "approved", at: T0 } }),
        { ...placement("att-a", "host:r1", "accepted", { sessionId: "s-new" }), placement: 2 },
        placement("att-a", "host:r9", "accepted", { sessionId: "s-new" }),
        placement("att-a", "host:r1", "accepted", { sessionId: "s-old-0" }),
      ]) {
        await put(s, e.successor, placementRef("att-a"), p);
        await gate.review();
        assert.equal((await holdOf(s)).attempts.find((x) => x.attemptId === "att-a")!.resolved, undefined, JSON.stringify(p));
      }
      // a completed result, or an offer, taken up in a new session is not reconciled by that: only by its end
      await put(s, e.successor, placementRef("att-c"), placement("att-c", "host:r2", "accepted", { sessionId: "s-new" }));
      await put(s, e.successor, placementRef("att-o"), placement("att-o", "host:r2", "accepted", { sessionId: "s-new" }));
      await gate.review();
      assert.deepEqual((await holdOf(s)).attempts.filter((x) => x.resolved !== undefined), []);
      assert.equal(await revisionOf(s), r0);
      await put(s, e.successor, placementRef("att-c"), placement("att-c", "host:r2", "completed", { sessionId: "s-old-2", result: { status: "completed" } }));
      await put(s, e.successor, placementRef("att-o"), placement("att-o", "host:r2", "offered"));

      // the local attempt's lease ended it: its host is reconciled
      clock = "2026-11-27T12:02:00.000Z";
      await put(s, e.successor, dispatchRef("att-b"), { ...running("att-b", "local"), state: "finished", outcome: { status: "abandoned", summary: "lease" } });
      let h = (await gate.review())!;
      assert.deepEqual(h.attempts.find((x) => x.attemptId === "att-b")!.resolved, { how: "ended", at: "2026-11-27T12:02:00.000Z", detail: "it ended (abandoned)" });
      assert.deepEqual(h.hosts.find((x) => x.hostId === "local"), { hostId: "local", attempts: 1, reconciledAt: "2026-11-27T12:02:00.000Z", reconnected: false });
      assert.equal(h.state, "held");
      assert.match((await gate.startReason())!, /2 worker hosts are not reconciled yet \(host:r1, host:r2\)/);

      // the owner approves the reconnected worker's session on host r1 (it connected to this controller)
      await put(s, e.successor, { kind: SESSION_KIND, id: "host:r1" }, { hostId: "host:r1", sessionId: "s-new", sessionEpoch: 2, primaryEpoch: e.successor });
      await put(s, e.successor, placementRef("att-a"), placement("att-a", "host:r1", "accepted", { sessionId: "s-old-1", reaccept: { sessionId: "s-new", state: "approved", at: T0, by: "rob" } }));
      h = (await gate.review())!;
      assert.deepEqual(h.attempts.find((x) => x.attemptId === "att-a")!.resolved?.how, "taken-up");
      assert.deepEqual(h.hosts.find((x) => x.hostId === "host:r1")?.reconnected, true);
      assert.equal(await gate.heldForReaccept("att-a"), false, "decided: the take-up goes through");
      // restart: a new gate on the same store holds as before
      const again = workersHoldGate(s, e.successor + 1, await beginWorkersHold(s, e.successor + 1, now) as WorkersHold, now);
      assert.match((await again.startReason())!, /1 worker host is not reconciled yet \(host:r2\)/);
      assert.match((await again.adoptReason({ attemptId: "att-c", primaryEpoch: e.old }))!, /kept as evidence/);

      // the attempt with the old result and the old offer end: the last host is reconciled and the hold is released, once
      clock = "2026-11-27T12:03:00.000Z";
      await put(s, e.successor, dispatchRef("att-c"), { ...running("att-c", "host:r2", e.old), state: "finished", outcome: { status: "abandoned" } });
      await gate.review();
      assert.equal((await holdOf(s)).state, "held", "one attempt of host r2 is still open");
      await put(s, e.successor, dispatchRef("att-o"), { ...running("att-o", "host:r2", e.old), state: "finished", outcome: { status: "abandoned" } });
      h = (await gate.review())!;
      assert.deepEqual([h.state, h.releasedAt], ["released", "2026-11-27T12:03:00.000Z"]);
      const r1 = await revisionOf(s);
      assert.equal(await gate.startReason(), undefined);
      assert.equal(await gate.adoptReason({ attemptId: "att-c", primaryEpoch: e.old }), undefined);
      assert.equal(await gate.heldForReaccept("att-o"), false);
      assert.equal(await gate.review(), undefined, "a released hold is not looked at again");
      assert.equal(await again.startReason(), undefined, "another process reads the release");
      assert.equal(await revisionOf(s), r1);
      // the evidence stays in the released record
      const kept = await holdOf(s);
      assert.equal(kept.attempts.length, 4);
      assert.equal(kept.attempts.find((x) => x.attemptId === "att-c")!.storedResult, true);
      assert.match(text(kept), /4 attempts of the fenced controller were running; all 3 hosts were reconciled and work started again at 2026-11-27T12:03:00.000Z \(3 ended, 1 taken up again with your approval\)\./);
      // a later start does not hold again for the same promotion
      assert.equal((await beginWorkersHold(s, e.successor + 1, now) as WorkersHold).state, "released");
      assert.equal(await workersHoldGate(s, e.successor + 1, kept, now).startReason(), undefined);
      // the audit names each step
      const audit = (await s.listAudit({ afterSeq: 0, limit: 200 })).map((x) => x.type).filter((t) => t.startsWith("controller.workers."));
      assert.deepEqual(audit, ["controller.workers.held", "controller.workers.reconciled", "controller.workers.reconciled", "controller.workers.resolved", "controller.workers.released"]);
    } finally { await w.close(); }
  });

  test(`${backend.name}: without a promotion nothing is held; with nothing of the fenced controller running the hold is written released; a hold that cannot be read holds everything; a fenced successor cannot record`, async () => {
    const w = await backend.open();
    try {
      clock = T0;
      const s = w.storage;
      const first = (await s.acquireEpoch({ holder: "ctl-a", at: T0 })).epoch;
      assert.equal(await beginWorkersHold(s, first, now), undefined);
      assert.equal(await readWorkersHold(s), undefined);
      assert.equal(await workersHoldGate(s, first, undefined, now).startReason(), undefined);
      // a fence that has not named a successor holds no workers (no controller starts at all)
      const fence = (await s.acquireEpoch({ holder: fenceHolder("p1", first, "ctl-a"), at: T0, expectedEpoch: first })).epoch;
      await put(s, fence, CONTROLLER_AUTHORITY, { ...promoted("p1", first, fence), state: "fenced" });
      assert.equal(await beginWorkersHold(s, fence, now), undefined);
      await put(s, fence, CONTROLLER_AUTHORITY, promoted("p1", first, fence));
      const succ = (await s.acquireEpoch({ holder: "ctl-b", at: T0, expectedEpoch: fence })).epoch;
      const h = await beginWorkersHold(s, succ, now) as WorkersHold;
      assert.deepEqual([h.state, h.releasedAt, h.attempts, h.hosts], ["released", T0, [], []]);
      assert.match(text(h), /nothing of the fenced controller was running, so no worker was held/);
      assert.equal(await workersHoldGate(s, succ, h, now).startReason(), undefined);
      const audit = (await s.listAudit({ afterSeq: 0, limit: 50 })).map((x) => x.type).filter((t) => t.startsWith("controller.workers."));
      assert.deepEqual(audit, ["controller.workers.released"]);

      // a damaged hold: the start goes on with everything held, nothing is written over it
      await put(s, succ, { kind: WORKERS_HOLD_KIND, id: "p1" }, { format: 1, state: "held", promotionId: "p1" });
      const r = await revisionOf(s);
      const bad = await beginWorkersHold(s, succ, now);
      assert.deepEqual(bad, { promotionId: "p1", unreadable: true });
      const g = workersHoldGate(s, succ, bad, now);
      assert.match((await g.startReason())!, /cannot be read, so no work starts/);
      assert.match((await g.adoptReason({ attemptId: "att-x", primaryEpoch: succ }))!, /cannot be read/);
      assert.equal(await g.heldForReaccept("att-x"), true);
      await assert.rejects(g.review(), /cannot be read/);
      assert.equal(await readWorkersHold(s), "unreadable");
      assert.match(text("unreadable"), /cannot be read, so no work starts/);
      assert.equal(await revisionOf(s), r, "nothing written over it");
      // a removed hold holds everything too
      const removedFor = new WorkersHoldGate(s, succ, "p-gone", now);
      assert.match((await removedFor.startReason())!, /cannot be read/);

      // a gate of a controller that lost the epoch records nothing
      await put(s, succ, { kind: WORKERS_HOLD_KIND, id: "p1" }, { ...h, state: "held", attempts: [{ attemptId: "att-q", taskId: "t", hostId: "local", primaryEpoch: first, leaseUntil: null, placement: null, placementState: null, sessions: [], storedResult: false }], hosts: [{ hostId: "local", attempts: 1 }] });
      await s.acquireEpoch({ holder: "ctl-c", at: T0 });
      const stale = new WorkersHoldGate(s, succ, "p1", now);
      await assert.rejects(stale.review(), (e: unknown) => /stale_epoch/.test(String((e as { kind?: string })?.kind ?? "") + String((e as Error)?.message ?? "")));
    } finally { await w.close(); }
  });
}

test("the hold record is read strictly: every damaged form is unreadable, never a hold that lets work through", () => {
  const good: WorkersHold = { format: 1, promotionId: "p1", successor: "ctl-b", fencedEpoch: 1, fenceEpoch: 2, heldEpoch: 3, heldAt: T0, state: "held", attempts: [{ attemptId: "att-a", taskId: "t", hostId: "local", primaryEpoch: 1, leaseUntil: null, placement: null, placementState: null, sessions: ["s"], storedResult: false }], truncated: false, hosts: [{ hostId: "local", attempts: 1 }] };
  const agg = (body: unknown) => ({ ref: { kind: WORKERS_HOLD_KIND, id: "p1" }, revision: 1, body }) as never;
  assert.deepEqual(parseWorkersHold(agg(good)), good);
  assert.equal(parseWorkersHold(undefined), undefined);
  const damaged: unknown[] = [
    null, [], "held", { ...good, format: 2 }, { ...good, state: "open" }, { ...good, promotionId: "" }, { ...good, promotionId: "p 1" }, { ...good, successor: 7 }, { ...good, fenceEpoch: -1 }, { ...good, fencedEpoch: 1.5 },
    { ...good, heldEpoch: "3" }, { ...good, heldAt: 0 }, { ...good, truncated: "no" }, { ...good, attempts: {} }, { ...good, hosts: null },
    { ...good, attempts: [{ ...good.attempts[0], attemptId: "" }] }, { ...good, attempts: [{ ...good.attempts[0], hostId: "a\nb" }] }, { ...good, attempts: [{ ...good.attempts[0], sessions: [1] }] },
    { ...good, attempts: [{ ...good.attempts[0], storedResult: "yes" }] }, { ...good, attempts: [{ ...good.attempts[0], taskId: 1 }] }, { ...good, attempts: [null] }, { ...good, hosts: [{ hostId: "local", attempts: -1 }] },
    { ...good, hosts: [{ hostId: "‮", attempts: 1 }] }, { ...good, attempts: Array.from({ length: WORKERS_HOLD_LIMITS.attempts + 1 }, () => good.attempts[0]) },
  ];
  for (const body of damaged) assert.equal(parseWorkersHold(agg(body)), "unreadable", JSON.stringify(body)?.slice(0, 120));
});

test("more running attempts of the fenced controller than are listed: the rest are counted, and the hold stays until none of them runs", async () => {
  const s = new MemoryStorage();
  clock = T0;
  const old = (await s.acquireEpoch({ holder: "ctl-a", at: T0 })).epoch;
  const ids = Array.from({ length: WORKERS_HOLD_LIMITS.attempts + 2 }, (_, i) => `att-${String(i).padStart(4, "0")}`);
  await put(s, old, DISPATCH_LIVE, { ids });
  for (const id of ids) await put(s, old, dispatchRef(id), running(id, "local", old));
  const fence = (await s.acquireEpoch({ holder: fenceHolder("p1", old, "ctl-a"), at: T0, expectedEpoch: old })).epoch;
  await put(s, fence, CONTROLLER_AUTHORITY, promoted("p1", old, fence));
  const succ = (await s.acquireEpoch({ holder: "ctl-b", at: T0, expectedEpoch: fence })).epoch;
  const h = await beginWorkersHold(s, succ, now) as WorkersHold;
  assert.deepEqual([h.attempts.length, h.truncated], [WORKERS_HOLD_LIMITS.attempts, true]);
  const gate = workersHoldGate(s, succ, h, now);
  assert.equal(await gate.heldForReaccept(ids.at(-1)!), true, "an attempt beyond the list is held as well");
  assert.match(text(h), /200\+ attempts of the fenced controller were running/);
  // every listed attempt ends; the two beyond the list still run
  for (const id of ids.slice(0, WORKERS_HOLD_LIMITS.attempts)) await put(s, succ, dispatchRef(id), { ...running(id, "local", old), state: "finished" });
  let r = (await gate.review())!;
  assert.equal(r.state, "held");
  assert.equal(r.hosts[0]!.reconciledAt, T0);
  assert.match((await gate.startReason())!, /attempts of the fenced controller are still running beyond the ones listed/);
  assert.match(text(r), /and attempts beyond the list still run/);
  // taken over by this controller (its own epoch now) or ended: released
  await put(s, succ, dispatchRef(ids.at(-1)!), running(ids.at(-1)!, "local", succ));
  await put(s, succ, dispatchRef(ids.at(-2)!), { ...running(ids.at(-2)!, "local", old), state: "finished" });
  r = (await gate.review())!;
  assert.equal(r.state, "released");
});

test("an attempt put back to wait is reconciled only once no live placement of it is left (a waiting local attempt at once)", async () => {
  const s = new MemoryStorage();
  clock = T0;
  const e = await world(s);
  const gate = workersHoldGate(s, e.successor, await beginWorkersHold(s, e.successor, now) as WorkersHold, now);
  await put(s, e.successor, dispatchRef("att-o"), { ...running("att-o", "host:r2", e.old), state: "waiting" });
  await put(s, e.successor, dispatchRef("att-a"), { ...running("att-a", "host:r1", e.old), state: "parked" });
  await put(s, e.successor, dispatchRef("att-b"), { ...running("att-b", "local"), state: "waiting" });
  let h = (await gate.review())!;
  const how = (id: string) => h.attempts.find((x) => x.attemptId === id)!.resolved;
  assert.equal(how("att-o"), undefined, "its offer is still live");
  assert.equal(how("att-a"), undefined, "its worker still holds the accepted run");
  assert.deepEqual(how("att-b"), { how: "ended", at: T0, detail: "it no longer runs on a worker (waiting)" });
  await put(s, e.successor, placementRef("att-o"), placement("att-o", "host:r2", "ended"));
  await put(s, e.successor, placementRef("att-a"), { ...placement("att-a", "host:r1", "accepted", { sessionId: "s-old-1" }), placement: 2 });
  h = (await gate.review())!;
  assert.deepEqual([how("att-o")?.detail, how("att-a")?.detail], ["it no longer runs on a worker (waiting)", "it no longer runs on a worker (parked)"]);
});
