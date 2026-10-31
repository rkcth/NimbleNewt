import assert from "node:assert/strict";
import { after, test } from "node:test";
import { backends, stopServer } from "../domain/testing/backends.js";
import type { DispatcherDeps, RouteChoice } from "./dispatcher.js";
import { buildWorld, workGrants } from "./testing/world.js";

after(stopServer);

// Card C07f: a task that last ran on one route and is about to run on another has its context built again for the new route before the attempt starts; a refusal keeps the attempt from starting, with the reason shown.
const choice = (route: string): RouteChoice => ({ route, harness: "pi", role: "worker", request: { contextTokens: 1000, needs: [], data: "local-only", paidAuthorized: false } });

for (const backend of backends) {
  test(`${backend.name}: a changed route is announced to the context before the attempt starts; the same route is not; a refusal blocks with its reason; an error waits`, async () => {
    const store = await backend.open();
    try {
      let current = "cloud/big";
      const w = await buildWorld(store.storage, { route: async () => choice(current) });
      const calls: { route: string; previousRoute: string; taskId: string }[] = [];
      let answer: "ok" | "refuse" | "throw" = "ok";
      const routeChange: NonNullable<DispatcherDeps["routeChange"]> = async (c) => {
        calls.push({ route: c.route, previousRoute: c.previousRoute, taskId: c.taskId });
        if (answer === "throw") throw new Error("the context service is down");
        return answer === "ok" ? { ok: true } : { ok: false, reason: "essential constraints do not fit the 8192-token route" };
      };
      const errors: unknown[] = [];
      const dispatcher = w.restart({ routeChange }, { onError: (e) => errors.push(e) });
      const ann = await w.agent("ann", workGrants(w.project, []));
      const made = await w.task("Prune roses", ann);
      const next = async (): Promise<string> => {
        const a = (await w.assignments.getAssignment(made.taskId))!;
        return (await w.assignments.admitAttempt({ commandId: `again-${Math.random().toString(36).slice(2)}`, actor: "inbox", taskId: made.taskId, expectedRevision: a.revision, generation: a.generation, owner: { kind: "agent", id: "ann" }, harness: "pi" })).id;
      };
      const run = async (): Promise<void> => { await w.heartbeatHost(); await dispatcher.tick(); await dispatcher.idle(); };
      // The first attempt has no earlier route: nothing to rebuild.
      await run();
      assert.deepEqual(calls, []);
      const ran = (): number => w.worker.starts.length;
      const first = ran();
      assert.ok(first >= 1, "the first attempt ran");
      // The same route again: not announced.
      await next(); await run();
      assert.deepEqual(calls, []);
      assert.ok(ran() > first);
      // Another route and the context refuses: the attempt does not start, and the blocker says why.
      current = "local/small"; answer = "refuse";
      const before = ran();
      const refused = await next(); await run();
      assert.equal(ran(), before, "the worker was not started");
      assert.ok(calls.length >= 1); assert.deepEqual(calls[0], { route: "local/small", previousRoute: "cloud/big", taskId: made.taskId });
      const blocker = await w.blockers.openFor("dispatch_blocked", { kind: "task", id: made.taskId });
      assert.match(JSON.stringify(blocker), /essential constraints do not fit the 8192-token route/);
      void refused;
      // An error is not a refusal: the attempt waits and is asked again.
      answer = "throw"; await run();
      assert.equal(ran(), before);
      assert.ok(errors.some((e) => /context service is down/.test(String(e))));
      // The context accepts: the attempt starts on the new route.
      answer = "ok"; await run();
      assert.ok(ran() > before, "started once the context was rebuilt");
    } finally { await store.close(); }
  });
}

for (const backend of backends) {
  test(`${backend.name}: an accepted route change is not rebuilt on every tick while the start waits for a host; a task back on its route has the stale refusal closed once`, async () => {
    const store = await backend.open();
    try {
      let current = "cloud/big";
      const w = await buildWorld(store.storage, { route: async () => choice(current) });
      const calls: string[] = []; const kept: string[] = [];
      const dispatcher = w.restart({ routeChange: async (c) => { calls.push(`${c.previousRoute}>${c.route}`); return { ok: true }; }, routeKept: async (k) => { kept.push(k.taskId); } }, {});
      const ann = await w.agent("ann", workGrants(w.project, []));
      const made = await w.task("Prune roses", ann);
      const again = async (): Promise<void> => {
        const a = (await w.assignments.getAssignment(made.taskId))!;
        await w.assignments.admitAttempt({ commandId: `again-${Math.random().toString(36).slice(2)}`, actor: "inbox", taskId: made.taskId, expectedRevision: a.revision, generation: a.generation, owner: { kind: "agent", id: "ann" }, harness: "pi" });
      };
      await w.heartbeatHost(); await dispatcher.tick(); await dispatcher.idle();
      const started = w.worker.starts.length;
      assert.ok(started >= 1);
      // The route changes and the host is gone: the attempt waits at the host step, tick after tick; the context is asked once.
      current = "local/small";
      await again(); w.clock.advance(10 * 60_000);
      for (let i = 0; i < 4; i++) { await dispatcher.tick(); await dispatcher.idle(); }
      assert.equal(w.worker.starts.length, started, "nothing started without a host");
      assert.deepEqual(calls, ["cloud/big>local/small"], "asked once, not on every tick");
      await w.heartbeatHost(); await dispatcher.tick(); await dispatcher.idle();
      assert.ok(w.worker.starts.length > started);
      assert.equal(calls.length, 1);
      // Back on the route it ran on: the stale-refusal hook is called (once for the attempt), the change hook is not.
      current = "local/small";
      await again(); await w.heartbeatHost(); await dispatcher.tick(); await dispatcher.idle(); await dispatcher.tick(); await dispatcher.idle();
      assert.deepEqual(kept, [made.taskId]);
      assert.equal(calls.length, 1);
    } finally { await store.close(); }
  });
}
