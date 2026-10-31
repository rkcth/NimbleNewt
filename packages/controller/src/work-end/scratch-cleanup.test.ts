import assert from "node:assert/strict";
import { after, test } from "node:test";
import { backends, stopServer } from "../domain/testing/backends.js";
import type { Principal } from "../security/principals.js";
import { buildWorld } from "../dispatch/testing/world.js";
import { ScratchCleanupService, SCRATCH_LIMITS, WorkEndService, type EndingAttempt, type Leftover, type ScratchMode, type ScratchOrder, type ScratchReport, type SettleReport, type WorkEndDeps } from "./index.js";

after(stopServer);

for (const backend of backends) {
  interface Opts {
    mode?: ScratchMode; checkpoint?: boolean; settle?: SettleReport; submitFails?: boolean; noHost?: boolean; hostThrows?: boolean;
    report?: ScratchReport; reportFailsOnce?: boolean; stopped?: boolean;
  }
  const rig = async (opts: Opts = {}) => {
    const store = await backend.open();
    const w = await buildWorld(store.storage);
    await w.principals.enroll(w.owner, { commandId: "en-ann", kind: "agent", name: "ann", grants: [] });
    const ann: Principal = await w.principals.authenticate((await w.principals.issueCredential(w.owner, "agent:ann")).token);
    const { taskId } = await w.task("t", { aid: "ann" });
    const s = { attempt: { attemptId: "att-1", taskId, projectId: w.project, agentId: "agent:ann", live: true, ...(opts.stopped ? { stopped: { by: "owner" as const, reason: "stop" } } : {}) } as EndingAttempt, finished: 0, orders: [] as { order: ScratchOrder; finishedAtOrder: number }[], reports: [] as { leftovers: readonly Leftover[]; key: string }[], mode: opts.mode ?? "after-handoff", checkpoint: opts.checkpoint ?? false, reportFailed: false, reportCalls: 0 };
    const cleanup = ScratchCleanupService.withEpoch(w.storage, w.epoch, {
      mode: async () => s.mode,
      ...(opts.noHost ? {} : { order: async (order: ScratchOrder) => { s.orders.push({ order, finishedAtOrder: s.finished }); if (opts.hostThrows) throw new Error("host down"); return opts.report ?? { removed: true, leftovers: [] }; } }),
      report: async (_a, leftovers, key) => { s.reportCalls++; if (opts.reportFailsOnce && !s.reportFailed) { s.reportFailed = true; throw new Error("supervisor inbox busy"); } s.reports.push({ leftovers, key }); },
    }, { clock: w.clock.now });
    const deps: WorkEndDeps = {
      attempts: {
        get: async (id) => (id === "att-1" ? s.attempt : undefined),
        freeze: async () => undefined,
        settle: async () => opts.settle ?? { killed: [] },
        finish: async () => { s.finished++; s.attempt = { ...s.attempt, live: false }; },
      },
      landing: async () => ({ base: "h1", head: "h1", mine: ["a.ts"], landed: [] }),
      submit: async () => { if (opts.submitFails) throw new Error("git said no"); return { submissionId: "sub-1" }; },
      blockers: { openBlocker: async (c) => w.blockers.openBlocker(c) },
      scratch: { cleanup, checkpointRecorded: async () => s.checkpoint },
    };
    const make = () => WorkEndService.withEpoch(w.storage, w.epoch, deps, { clock: w.clock.now });
    return { store, w, ann, s, cleanup, service: make(), make };
  };

  test(`${backend.name}: scratch is ordered only after the attempt is finished and the work was submitted, once, and a replay or a second instance orders nothing more`, async () => {
    const r = await rig();
    try {
      await r.service.request(r.ann, { commandId: "e1", attemptId: "att-1", submit: true, result: "done" });
      const done = await r.service.complete("att-1");
      assert.equal(done.state, "done");
      assert.equal(done.steps?.["cleanup.scratch"]?.state, "removed");
      assert.equal(r.s.orders.length, 1);
      assert.equal(r.s.orders[0]!.finishedAtOrder, 1, "the attempt was already finished when the order went out");
      assert.deepEqual([r.s.orders[0]!.order.attemptId, r.s.orders[0]!.order.key], ["att-1", "scratch:att-1"]);
      await r.service.complete("att-1"); await r.make().complete("att-1");
      assert.equal(r.s.orders.length, 1, "replay-safe: one order");
      assert.equal((await r.cleanup.get("att-1"))?.state, "removed", "the removal is recorded (the log)");
    } finally { await r.store.close(); }
  });

  test(`${backend.name}: scratch is kept while the hand-off is incomplete: no checkpoint for a plain end, a failed submission, a killed write call`, async () => {
    for (const [name, o, submit, why] of [
      ["plain end, no checkpoint", {}, false, /no checkpoint/],
      ["submission failed", { submitFails: true }, true, /no submission|no checkpoint/],
      ["write call killed", { settle: { killed: [{ callId: "c1", write: true, reason: "hung" }] } }, true, /write call/],
    ] as const) {
      const r = await rig(o);
      try {
        await r.service.request(r.ann, { commandId: "e1", attemptId: "att-1", submit, result: "partial" });
        const done = await r.service.complete("att-1");
        assert.equal(done.state, "done", name);
        assert.equal(r.s.orders.length, 0, `${name}: no order`);
        assert.equal(done.steps?.["cleanup.scratch"]?.state, "kept", name);
        assert.match(done.steps?.["cleanup.scratch"]?.why ?? "", why, name);
      } finally { await r.store.close(); }
    }
  });

  test(`${backend.name}: a plain end with a recorded checkpoint hands onward, so the scratch is ordered removed`, async () => {
    const r = await rig({ checkpoint: true });
    try {
      await r.service.request(r.ann, { commandId: "e1", attemptId: "att-1", result: "blocked" });
      assert.equal((await r.service.complete("att-1")).steps?.["cleanup.scratch"]?.state, "removed");
      assert.equal(r.s.orders.length, 1);
    } finally { await r.store.close(); }
  });

  test(`${backend.name}: the setting keep disables the order; a host that cannot, or fails, keeps the scratch`, async () => {
    for (const [name, o, why] of [["keep", { mode: "keep" as const }, /setting is keep/], ["no host", { noHost: true }, /no host/], ["host throws", { hostThrows: true }, /host could not/]] as const) {
      const r = await rig(o);
      try {
        await r.service.request(r.ann, { commandId: "e1", attemptId: "att-1", submit: true, result: "done" });
        const done = await r.service.complete("att-1");
        assert.equal(done.steps?.["cleanup.scratch"]?.state, "kept", name);
        assert.match(done.steps?.["cleanup.scratch"]?.why ?? "", why, name);
        assert.equal(r.s.orders.length, name === "host throws" ? 1 : 0, name);
        // Not retried by a later pass: the decision is recorded.
        await r.service.complete("att-1");
        assert.equal(r.s.orders.length, name === "host throws" ? 1 : 0, `${name}: not repeated`);
      } finally { await r.store.close(); }
    }
  });

  test(`${backend.name}: leftovers are reported to the boss once, bounded, never removed by the controller; a failed report is retried without a second order`, async () => {
    const many = Array.from({ length: 50 }, (_, i) => ({ kind: i === 0 ? "bogus" : "running", what: `proc ${i} ${"x".repeat(500)}` })) as unknown as Leftover[];
    const r = await rig({ report: { removed: true, leftovers: many }, reportFailsOnce: true });
    try {
      await r.service.request(r.ann, { commandId: "e1", attemptId: "att-1", submit: true, result: "done" });
      await assert.rejects(() => r.service.complete("att-1"), /inbox/, "the ending stays open while the report is undelivered");
      assert.equal((await r.service.get("att-1"))?.state, "ending");
      const done = await r.service.complete("att-1");
      assert.equal(done.state, "done");
      assert.equal(r.s.orders.length, 1, "the retry did not order again");
      assert.equal(r.s.reports.length, 1);
      assert.equal(r.s.reports[0]!.key, "scratch-leftovers:att-1");
      assert.equal(r.s.reports[0]!.leftovers.length, SCRATCH_LIMITS.leftovers);
      assert.ok(r.s.reports[0]!.leftovers.every((l) => l.what.length <= SCRATCH_LIMITS.what));
      assert.equal(r.s.reports[0]!.leftovers[0]!.kind, "other", "an unknown kind is clamped");
      await r.make().complete("att-1");
      assert.equal(r.s.reports.length, 1, "reported once");
    } finally { await r.store.close(); }
  });

  test(`${backend.name}: an attempt that ended another way (stop, failure) keeps its scratch until a checkpoint is recorded; an open ending is left to its own completion`, async () => {
    const r = await rig({ stopped: true });
    try {
      await r.service.cleanupAfterEnd("att-1");
      assert.equal(r.s.orders.length, 0);
      assert.match((await r.cleanup.get("att-1"))?.why ?? "", /no checkpoint/);
    } finally { await r.store.close(); }
    const q = await rig({ stopped: true, checkpoint: true });
    try {
      await q.service.cleanupAfterEnd("att-1"); await q.service.cleanupAfterEnd("att-1");
      assert.equal(q.s.orders.length, 1, "ordered once");
      assert.equal((await q.cleanup.get("att-1"))?.state, "removed");
    } finally { await q.store.close(); }
    const o = await rig({ checkpoint: true });
    try {
      await o.service.request(o.ann, { commandId: "e1", attemptId: "att-1", submit: true });
      await o.service.cleanupAfterEnd("att-1");
      assert.equal(o.s.orders.length, 0, "an ending still open is not cleaned from the side");
    } finally { await o.store.close(); }
  });
}
