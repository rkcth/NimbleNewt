import assert from "node:assert/strict";
import { test } from "node:test";
import { DISPATCH_LIMITS, withSlotSpans, type DispatchBody } from "./model.js";

// The usage sink (card M03h): the slot spans a move into or out of `running` writes.
const base = { attemptId: "att-1", taskId: "t", projectId: "p", agentId: "a", generation: 1, state: "waiting", heartbeats: 0, inFlight: [], parked: [] } as unknown as DispatchBody;
const as = (b: DispatchBody, patch: Partial<DispatchBody>): DispatchBody => ({ ...b, ...patch }) as DispatchBody;
const T = (h: number, m = 0): string => new Date(Date.UTC(2026, 9, 20, h, m)).toISOString();

test("a run that ends after its lease ran out (ended as lost when a controller came back hours later) is closed when the lease ran out, not when the loss was noticed", () => {
  const running = as(base, { state: "running", startedAt: T(9), lease: { holder: "d1", until: T(9, 1) }, slotSpans: [{ from: T(9) }] });
  const lost = withSlotSpans(running, as(running, { state: "finished" }), T(17));
  assert.deepEqual(lost.slotSpans, [{ from: T(9), to: T(9, 1) }]);
  // A run whose lease is still good ends when it ends.
  const fine = withSlotSpans(as(running, { lease: { holder: "d1", until: T(18) } }), as(running, { state: "finished" }), T(17));
  assert.deepEqual(fine.slotSpans, [{ from: T(9), to: T(17) }]);
});

test("a span never opens before the end of the one before it, so a clock set back cannot make spans overlap", () => {
  const parked = as(base, { state: "parked", startedAt: T(9), slotSpans: [{ from: T(9), to: T(10) }] });
  const resumed = withSlotSpans(parked, as(parked, { state: "running" }), T(9, 30));
  assert.deepEqual(resumed.slotSpans, [{ from: T(9), to: T(10) }, { from: T(10) }]);
});

test("a record that ran before the sink and opens its first span now has its cut set, so its earlier runs are said to be missing; a fresh record has no cut", () => {
  const old = as(base, { state: "parked", startedAt: T(8), lastHeartbeatAt: T(9) });
  const resumed = withSlotSpans(old, as(old, { state: "running" }), T(12));
  assert.deepEqual(resumed.slotSpans, [{ from: T(12) }]);
  assert.equal(resumed.slotSpansCut, T(9));
  const fresh = withSlotSpans(base, as(base, { state: "running", startedAt: T(12) }), T(12));
  assert.deepEqual(fresh.slotSpans, [{ from: T(12) }]);
  assert.equal(fresh.slotSpansCut, undefined);
  // A record that was running when the sink came in closes nothing and stays an older record.
  const was = as(base, { state: "running", startedAt: T(8) });
  assert.equal(withSlotSpans(was, as(was, { state: "parked" }), T(9)).slotSpans, undefined);
});

test("a replayed rewrite adds nothing, and spans past the bound are let go oldest first with the cut at the newest one let go", () => {
  const running = as(base, { state: "running", startedAt: T(1), slotSpans: [{ from: T(1) }] });
  assert.equal(withSlotSpans(running, running, T(2)), running);
  const many = Array.from({ length: DISPATCH_LIMITS.slotSpans }, (_, i) => ({ from: new Date(Date.UTC(2026, 9, 1) + i * 60_000).toISOString(), to: new Date(Date.UTC(2026, 9, 1) + i * 60_000 + 30_000).toISOString() }));
  const parked = as(base, { state: "parked", startedAt: many[0]!.from, slotSpans: many });
  const next = withSlotSpans(parked, as(parked, { state: "running" }), T(12));
  assert.equal(next.slotSpans!.length, DISPATCH_LIMITS.slotSpans);
  assert.equal(next.slotSpansCut, many[0]!.to);
  assert.deepEqual(next.slotSpans![next.slotSpans!.length - 1], { from: T(12) });
});
