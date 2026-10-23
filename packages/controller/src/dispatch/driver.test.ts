import assert from "node:assert/strict";
import { after, test } from "node:test";
import { DomainError } from "../domain/errors.js";
import { backends, stopServer } from "../domain/testing/backends.js";
import { DRIVER_LIMITS, DispatchDriver, realTimer } from "./driver.js";
import { ManualTimer } from "./testing/timer.js";
import type { TickReport } from "./dispatcher.js";

after(stopServer);

const report = (extra: Partial<TickReport> = {}): TickReport => ({ at: "2026-10-23T09:00:00.000Z", started: [], waiting: [], skipped: [], blocked: [], lost: [], readmitted: [], reprioritized: 0, approvals: [], loops: [], failures: [], scanned: 0, complete: true, ...extra });

function fake(tick: () => Promise<TickReport>) {
  const log = { ticks: 0, shutdowns: 0, idles: 0, drops: 0, shutdownFails: false };
  let began!: () => void;
  const started = new Promise<void>((resolve) => { began = resolve; });
  return {
    log, started,
    dispatcher: { tick: async () => { log.ticks++; began(); return tick(); }, shutdown: async () => { log.shutdowns++; if (log.shutdownFails) throw new Error("shutdown must not be called"); return { closed: 0, errors: [] as string[] }; }, idle: async () => { log.idles++; }, dropWorkers: async () => { log.drops++; } },
  };
}

for (const backend of backends) {
  const suite = (name: string, body: (store: Awaited<ReturnType<typeof backend.open>>, epoch: number) => Promise<void>) =>
    test(`${backend.name}: ${name}`, async () => {
      const store = await backend.open();
      try { await body(store, (await store.storage.acquireEpoch({ holder: "c1", at: "2026-10-23T09:00:00.000Z" })).epoch); } finally { await store.close(); }
    });

  suite("the timer drives one tick at a time, and the next is armed only when the last has ended", async ({ storage }, epoch) => {
    const timer = new ManualTimer();
    let finish!: () => void;
    const f = fake(() => new Promise<TickReport>((resolve) => { finish = () => resolve(report()); }));
    const d = new DispatchDriver({ dispatcher: f.dispatcher, storage, epoch, timer, intervalMs: 1000 });
    d.start();
    d.start();
    assert.deepEqual(timer.delays, [1000], "a second start does nothing");
    assert.equal(f.log.ticks, 0, "nothing runs before the timer fires");
    const fired = timer.fire();
    await f.started;
    assert.equal(f.log.ticks, 1);
    assert.equal(timer.armed, false, "no new timer while a tick runs");
    // A manual call during the tick joins it.
    const joined = d.runOnce();
    assert.equal(f.log.ticks, 1);
    finish();
    await joined;
    await fired;
    assert.deepEqual(timer.delays, [1000, 1000]);
    assert.equal(d.status().ticks, 1);
    await d.stop();
  });

  suite("a tick that throws is recorded and retried with a growing delay that is capped; a good tick resets it", async ({ storage }, epoch) => {
    const timer = new ManualTimer();
    const seen: unknown[] = [];
    let fail = true;
    const f = fake(async () => { if (fail) throw new Error("the store is down"); return report(); });
    const d = new DispatchDriver({ dispatcher: f.dispatcher, storage, epoch, timer, intervalMs: 1000, onError: (e) => seen.push(e) });
    d.start();
    for (let n = 0; n < 8; n++) await timer.fire();
    assert.deepEqual(timer.delays.slice(0, 5), [1000, 2000, 4000, 8000, 16000]);
    assert.equal(Math.max(...timer.delays), DRIVER_LIMITS.maxBackoffMs, "capped");
    assert.equal(seen.length, 8, "every failure reached the observer");
    assert.equal(d.status().failedTicks, 8);
    assert.match(d.status().errors[0]!.message, /store is down/);
    assert.equal(d.status().state, "running", "an error does not stop the loop");
    fail = false;
    await timer.fire();
    assert.deepEqual([d.status().consecutiveFailures, timer.delays.at(-1)], [0, 1000]);
    await d.stop();
  });

  suite("errors are kept bounded and the ones dropped are counted; a loop that failed inside a tick is counted by name", async ({ storage }, epoch) => {
    let n = 0;
    const f = fake(async () => report({ loops: [{ name: "messages.release", ok: false, error: `${n++}:${"x".repeat(2000)}` }, { name: "events.expireIdle", ok: true }] }));
    const d = new DispatchDriver({ dispatcher: f.dispatcher, storage, epoch, timer: new ManualTimer() });
    for (let i = 0; i < DRIVER_LIMITS.errorsKept + 7; i++) await d.runOnce();
    const s = d.status();
    assert.equal(s.errors.length, DRIVER_LIMITS.errorsKept);
    assert.equal(s.dropped, 7);
    assert.equal(s.loopFailures["messages.release"], DRIVER_LIMITS.errorsKept + 7);
    assert.equal(s.loopFailures["events.expireIdle"], undefined);
    assert.ok(s.errors.every((e) => e.message.length <= DRIVER_LIMITS.errorText && e.source === "messages.release"));
    assert.equal(s.consecutiveFailures, 0, "loop failures are not tick failures");
  });

  suite("the failures are written to the dispatch-health record, bounded, and survive the driver", async ({ storage }, epoch) => {
    const fail = { message: "boom" };
    const f = fake(async () => { throw new Error(fail.message); });
    const d = new DispatchDriver({ dispatcher: f.dispatcher, storage, epoch, timer: new ManualTimer(), record: { storage } });
    for (let i = 0; i < 100; i++) await d.runOnce();
    const saved = (await storage.getAggregate({ kind: "dispatch-health", id: "loops" }))!;
    const body = saved.body as unknown as { failedTicks: number; errors: { source: string; message: string; count: number }[] };
    assert.equal(saved.revision, 1, "100 ticks with the same failure are one write");
    assert.deepEqual(body.errors.map((e) => [e.source, e.message]), [["tick", "boom"]]);
    assert.equal(d.status().errors[0]!.count, 100, "and they are counted, not listed 100 times");
    // A different error is a new kind and is written at once.
    fail.message = "other";
    await d.runOnce();
    const after = (await storage.getAggregate({ kind: "dispatch-health", id: "loops" }))!;
    assert.equal(after.revision, 2);
    assert.deepEqual((after.body as unknown as { errors: { message: string }[] }).errors.map((e) => e.message), ["boom", "other"]);
    // Only counts changed: nothing is written until a minute has passed.
    await d.runOnce();
    assert.equal((await storage.getAggregate({ kind: "dispatch-health", id: "loops" }))!.revision, 2);
    await d.stop();
    assert.equal((await storage.getAggregate({ kind: "dispatch-health", id: "loops" }))!.revision, 3, "stop writes the final counts");
  });

  suite("a controller that no longer holds the epoch never ticks again: the instance that took over is the only one running the loops", async ({ storage }, epoch) => {
    const timer = new ManualTimer();
    const f = fake(async () => report());
    const d = new DispatchDriver({ dispatcher: f.dispatcher, storage, epoch, timer, intervalMs: 1000, record: { storage } });
    d.start();
    await timer.fire();
    assert.equal(f.log.ticks, 1);
    await storage.acquireEpoch({ holder: "c2", at: "2026-10-23T09:00:01.000Z" });
    await timer.fire();
    assert.equal(f.log.ticks, 1, "no tick was started under the old epoch");
    assert.equal(d.status().state, "fenced");
    assert.equal(timer.armed, false, "and no timer is armed");
    assert.equal(await d.runOnce(), undefined);
    assert.equal(d.status().errors.at(-1)?.source, "epoch");
    // The deposed controller writes nothing at all, not even its health record.
    assert.equal(await storage.getAggregate({ kind: "dispatch-health", id: "loops" }), undefined);
    assert.equal(f.log.drops, 1, "the local workers were ended when it was fenced");
    f.log.shutdownFails = true;
    await d.stop();
    assert.equal(f.log.shutdowns, 0, "a fenced stop never closes attempts in the store");
    assert.equal(d.status().state, "fenced");
  });

  suite("a write refused as from an old epoch in the middle of a tick fences the driver", async ({ storage }, epoch) => {
    const timer = new ManualTimer();
    const f = fake(async () => { throw new DomainError("stale_epoch", "this controller is no longer the primary"); });
    const d = new DispatchDriver({ dispatcher: f.dispatcher, storage, epoch, timer });
    d.start();
    await timer.fire();
    assert.equal(d.status().state, "fenced");
    assert.equal(timer.armed, false);
    assert.equal(d.status().failedTicks, 0, "it is not counted as a store failure to retry");
  });

  suite("stop is graceful: the tick running finishes, nothing new starts, the live attempts are closed, and a second stop is harmless", async ({ storage }, epoch) => {
    const timer = new ManualTimer();
    let finish!: () => void;
    const f = fake(() => new Promise<TickReport>((resolve) => { finish = () => resolve(report()); }));
    const d = new DispatchDriver({ dispatcher: f.dispatcher, storage, epoch, timer });
    d.start();
    const fired = timer.fire();
    await f.started;
    let stopped = false;
    const stopping = d.stop().then(() => { stopped = true; });
    assert.equal(stopped, false, "it waits for the tick");
    assert.equal(f.log.shutdowns, 0, "and does not close attempts under it");
    finish();
    await stopping;
    await fired;
    assert.deepEqual([f.log.shutdowns, f.log.idles, d.status().state], [1, 1, "stopped"]);
    assert.equal(timer.armed, false);
    await d.stop();
    assert.equal(f.log.shutdowns, 1);
    await timer.fire();
    assert.equal(f.log.ticks, 1, "a stopped driver never ticks");
    assert.equal(await d.runOnce(), undefined);
  });

  suite("an interval that is not a whole number of milliseconds is refused", async ({ storage }, epoch) => {
    const f = fake(async () => report());
    for (const intervalMs of [0, -1, 1.5, Number.NaN]) assert.throws(() => new DispatchDriver({ dispatcher: f.dispatcher, storage, epoch, intervalMs }), (e: unknown) => e instanceof DomainError && e.code === "invalid_command");
  });

  suite("a fence found by the last tick during stop is kept: stop does not turn it into stopped, and closes nothing", async ({ storage }, epoch) => {
    const timer = new ManualTimer();
    let finish!: () => void;
    const f = fake(() => new Promise<TickReport>((resolve) => { finish = () => resolve(report()); }));
    f.log.shutdownFails = true;
    const d = new DispatchDriver({ dispatcher: f.dispatcher, storage, epoch, timer });
    d.start();
    const fired = timer.fire();
    await f.started;
    await storage.acquireEpoch({ holder: "c2", at: "2026-10-23T09:00:01.000Z" });
    const stopping = d.stop();
    finish();
    await stopping; await fired;
    assert.equal(f.log.shutdowns, 0);
    assert.equal(d.status().state, "fenced");
  });

  suite("a dispatcher the owner disabled is noticed before the next tick: the attempts are closed, the driver stops for good, the owner is told once", async ({ storage }, epoch) => {
    const timer = new ManualTimer();
    const f = fake(async () => report());
    let enabled = true;
    const told: string[] = [];
    const d = new DispatchDriver({ dispatcher: f.dispatcher, storage, epoch, timer, enabled: async () => enabled, onDisabled: async (why) => { told.push(why); } });
    d.start();
    await timer.fire();
    assert.equal(f.log.ticks, 1);
    enabled = false;
    await timer.fire();
    assert.equal(f.log.ticks, 1, "no tick after the owner disabled it");
    assert.deepEqual([d.status().state, f.log.shutdowns, told.length, timer.armed], ["disabled", 1, 1, false]);
    assert.equal(d.status().errors.at(-1)?.source, "dispatcher");
    await d.stop();
    assert.equal(f.log.shutdowns, 1, "and stop does not close them again");
    assert.equal(told.length, 1);
  });
}

test("the real timer fires once after the delay, does not keep the process alive, and cancels", () => {
  const real = { set: globalThis.setTimeout, clear: globalThis.clearTimeout };
  const calls: { ms: number; unref: number; cleared: boolean; fn: () => void }[] = [];
  globalThis.setTimeout = ((fn: () => void, ms: number) => {
    const entry = { ms, unref: 0, cleared: false, fn };
    calls.push(entry);
    return { unref() { entry.unref++; return this; }, entry };
  }) as unknown as typeof setTimeout;
  globalThis.clearTimeout = ((handle: { entry: { cleared: boolean } }) => { handle.entry.cleared = true; }) as unknown as typeof clearTimeout;
  try {
    let ran = 0;
    const cancel = realTimer.schedule(1234, () => { ran++; });
    assert.deepEqual([calls.length, calls[0]!.ms, calls[0]!.unref], [1, 1234, 1]);
    calls[0]!.fn();
    assert.equal(ran, 1);
    cancel();
    assert.equal(calls[0]!.cleared, true);
  } finally { globalThis.setTimeout = real.set; globalThis.clearTimeout = real.clear; }
});
