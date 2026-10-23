import assert from "node:assert/strict";
import { after, test } from "node:test";
import { backends, stopServer } from "../domain/testing/backends.js";
import { buildWorld, workGrants } from "./testing/world.js";

after(stopServer);

for (const backend of backends) {
  test(`${backend.name}: the scan cursor survives a restart: each fresh dispatcher goes on from where the last stopped, and a finished pass starts over`, async () => {
    const store = await backend.open();
    try {
      const c = await buildWorld(store.storage, { options: { scanPage: 1 } });
      const ann = await c.agent("ann", workGrants(c.project));
      const made = [await c.task("a", ann), await c.task("b", ann), await c.task("c", ann)];
      const started: string[] = [];
      let scanned = 0;
      // Three ticks, each by a new dispatcher over the same storage (a restart before every tick). An in-memory cursor would look at the first assignment each time.
      for (let n = 0; n < 3; n++) {
        const d = c.restart();
        const report = await d.tick();
        await d.idle();
        scanned += report.scanned;
        started.push(...report.started);
        assert.equal(report.complete, false, `tick ${n + 1} did not reach the end`);
        const saved = await store.storage.getAggregate({ kind: "dispatch-cursor", id: "scan" });
        assert.ok(saved !== undefined && typeof (saved.body as { after?: string }).after === "string", "the position is stored");
      }
      assert.equal(scanned, 3);
      assert.deepEqual([...started].sort(), made.map((m) => m.attemptId!).sort(), "every admitted attempt was found exactly once");
      // The pass ends on the next tick (an empty page) and the stored position is cleared.
      const end = c.restart();
      const last = await end.tick();
      assert.deepEqual([last.scanned, last.complete, last.started.length], [0, true, 0]);
      assert.equal((await store.storage.getAggregate({ kind: "dispatch-cursor", id: "scan" }))!.body["after"], undefined);
      assert.equal(c.worker.starts.length, 3, "no attempt was started twice");
    } finally { await store.close(); }
  });

  test(`${backend.name}: a page scanned again after a restart (the cursor was behind) starts nothing twice and loses nothing`, async () => {
    const store = await backend.open();
    try {
      const c = await buildWorld(store.storage);
      const ann = await c.agent("ann", workGrants(c.project));
      const first = await c.task("a", ann);
      let release!: () => void;
      const gate = new Promise<void>((resolve) => { release = resolve; });
      c.worker.script = async () => { await gate; return { status: "completed", text: "done" }; };
      const one = await c.dispatcher.tick();
      assert.deepEqual(one.started, [first.attemptId]);
      // A new attempt is admitted behind the cursor's pass, then the controller restarts: the new dispatcher scans the whole range again, skips the running attempt and finds the new one.
      const second = await c.task("b", ann);
      const d2 = c.restart();
      const two = await d2.tick();
      assert.deepEqual(two.started, [second.attemptId]);
      assert.equal(c.worker.starts.length, 2);
      release();
      await d2.idle();
      await c.dispatcher.idle();
    } finally { await store.close(); }
  });

  test(`${backend.name}: a failure between the work on a page and the write of the cursor loses nothing: the claims were made first, and the next dispatcher starts nothing twice`, async () => {
    const store = await backend.open();
    try {
      const failing = { on: false, tried: 0 };
      const storage = new Proxy(store.storage, {
        get(target, key) {
          if (key === "applyOperation") return async (input: Parameters<typeof target.applyOperation>[0]) => {
            if (failing.on && input.changes.some((ch) => ch.ref.kind === "dispatch-cursor")) { failing.tried++; throw new Error("the disk is full"); }
            return target.applyOperation(input);
          };
          const value = (target as unknown as Record<PropertyKey, unknown>)[key];
          return typeof value === "function" ? (value as (...a: unknown[]) => unknown).bind(target) : value;
        },
      });
      const c = await buildWorld(storage, { options: { scanPage: 1 } });
      const ann = await c.agent("ann", workGrants(c.project));
      const made = [await c.task("a", ann), await c.task("b", ann)];
      failing.on = true;
      await assert.rejects(c.dispatcher.tick(), /disk is full|unavailable|could not/i);
      assert.ok(failing.tried > 0);
      failing.on = false;
      const claimed = [];
      for (const m of made) if ((await c.dispatcher.get(c.owner, m.attemptId!)) !== undefined) claimed.push(m.attemptId);
      assert.equal(claimed.length, 1, "the page's work (the claim) was done before the cursor was written");
      assert.equal(await store.storage.getAggregate({ kind: "dispatch-cursor", id: "scan" }), undefined, "and the position did not move");
      const again = c.restart();
      const report = await again.tick();
      await again.idle();
      assert.deepEqual(report.started, claimed, "the claimed attempt is started by the next dispatcher, once");
      assert.equal(c.worker.starts.length, 1);
    } finally { await store.close(); }
  });

  test(`${backend.name}: an empty page that only moves the cursor is not written every tick, and a pass that ends clears it`, async () => {
    const store = await backend.open();
    try {
      const c = await buildWorld(store.storage, { options: { scanPage: 1 } });
      const ann = await c.agent("ann", workGrants(c.project));
      for (const t of ["a", "b", "c", "d"]) await c.task(t, ann, { admit: false });
      const revision = async () => (await store.storage.getAggregate({ kind: "dispatch-cursor", id: "scan" }))?.revision;
      await c.dispatcher.tick();
      const first = await revision();
      assert.equal(first, 1);
      for (let n = 0; n < 2; n++) await c.dispatcher.tick();
      assert.equal(await revision(), first, "the position moved but the clock did not: no further write");
      c.clock.advance(61_000);
      await c.dispatcher.tick();
      assert.equal(await revision(), 2, "a minute later it is written");
      let last = await c.dispatcher.tick();
      for (let n = 0; n < 6 && !last.complete; n++) last = await c.dispatcher.tick();
      assert.equal(last.complete, true);
      assert.equal((await store.storage.getAggregate({ kind: "dispatch-cursor", id: "scan" }))!.body["after"], undefined, "the end of a pass is always written");
    } finally { await store.close(); }
  });
}
