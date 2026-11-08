import assert from "node:assert/strict";
import { after, test } from "node:test";
import { CommandRunner } from "../domain/runner.js";
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
      // Asked once more as the worker started (card C07g): the view for the first prompt is the one for the facts at the start.
      assert.deepEqual(calls, ["cloud/big>local/small", "cloud/big>local/small"]);
      // Back on the route it ran on: the stale-refusal hook is called (once for the attempt), the change hook is not.
      current = "local/small";
      await again(); await w.heartbeatHost(); await dispatcher.tick(); await dispatcher.idle(); await dispatcher.tick(); await dispatcher.idle();
      assert.deepEqual(kept, [made.taskId]);
      assert.equal(calls.length, 2);
    } finally { await store.close(); }
  });
}

// Writes (or rewrites) a record so its revision moves: all the dispatcher reads of the owner's decisions and settings is the revision.
const bump = async (storage: ConstructorParameters<typeof CommandRunner>[0], epoch: number, kind: string, id: string): Promise<void> => {
  const runner = new CommandRunner(storage, epoch, {});
  const ref = { kind, id };
  await runner.command("test.bump", { commandId: `bump-${Math.random().toString(36).slice(2)}`, actor: "owner:rob" }, async () => ({
    payload: {},
    build: async () => { const old = await runner.get(kind, id); return { ref, creates: old === undefined, changes: [old === undefined ? { type: "create" as const, ref, body: { n: 1 } } : { type: "update" as const, ref, expectedRevision: old.revision, body: { n: old.revision + 1 } }], detail: {} }; },
  }));
};

for (const backend of backends) {
  test(`${backend.name}: a flap to another route and back asks the context again: a refusal or an error does not leave the old "kept" answer standing`, async () => {
    const store = await backend.open();
    try {
      let current = "cloud/big";
      const w = await buildWorld(store.storage, { route: async () => choice(current) });
      const kept: string[] = [];
      let answer: "refuse" | "throw" = "refuse";
      const dispatcher = w.restart({
        routeChange: async () => { if (answer === "throw") throw new Error("down"); return { ok: false, reason: "does not fit" }; },
        routeKept: async (k) => { kept.push(k.taskId); },
      }, { onError: () => undefined });
      const ann = await w.agent("ann", workGrants(w.project, []));
      const made = await w.task("Prune roses", ann);
      const tick = async (): Promise<void> => { await dispatcher.tick(); await dispatcher.idle(); };
      await w.heartbeatHost(); await tick();
      const started = w.worker.starts.length;
      assert.ok(started >= 1);
      // A new attempt on the same route waits (no host); the context is told once that the task stays on its route.
      const a = (await w.assignments.getAssignment(made.taskId))!;
      await w.assignments.admitAttempt({ commandId: "again-1", actor: "inbox", taskId: made.taskId, expectedRevision: a.revision, generation: a.generation, owner: { kind: "agent", id: "ann" }, harness: "pi" });
      w.clock.advance(10 * 60_000);
      await tick(); await tick();
      assert.equal(kept.length, 1, "told once, then remembered");
      for (const failure of ["refuse", "throw"] as const) {
        // The route flaps to another and the move is refused (or cannot be judged): the "kept" answer is no longer true.
        answer = failure; current = "local/small"; await tick();
        assert.equal(w.worker.starts.length, started);
        const before: number = kept.length;
        // Back on the route it ran on: the stale refusal the move opened is closed again.
        current = "cloud/big"; await tick();
        assert.equal(kept.length, before + 1, `after a ${failure}, the return to the route asks the context to close the stale refusal`);
        await tick();
        assert.equal(kept.length, before + 1, "and is remembered again");
      }
    } finally { await store.close(); }
  });

  test(`${backend.name}: the remembered "fits" answer is asked again when the owner's decisions or the route settings change`, async () => {
    const store = await backend.open();
    try {
      let current = "cloud/big";
      const w = await buildWorld(store.storage, { route: async () => choice(current) });
      const calls: string[] = [];
      const dispatcher = w.restart({ routeChange: async (c) => { calls.push(c.route); return { ok: true }; } }, {});
      const ann = await w.agent("ann", workGrants(w.project, []));
      const made = await w.task("Prune roses", ann);
      const tick = async (): Promise<void> => { await dispatcher.tick(); await dispatcher.idle(); };
      await w.heartbeatHost(); await tick();
      const a = (await w.assignments.getAssignment(made.taskId))!;
      await w.assignments.admitAttempt({ commandId: "again-1", actor: "inbox", taskId: made.taskId, expectedRevision: a.revision, generation: a.generation, owner: { kind: "agent", id: "ann" }, harness: "pi" });
      w.clock.advance(10 * 60_000);
      current = "local/small";
      await tick(); await tick(); await tick();
      assert.deepEqual(calls, ["local/small"], "asked once while nothing changed");
      await bump(store.storage, w.epoch, "decision-context", w.project); await tick(); await tick();
      assert.equal(calls.length, 2, "a new decision or goal is a new question");
      await bump(store.storage, w.epoch, "ctx-route-settings", "main"); await tick(); await tick();
      assert.equal(calls.length, 3, "a toggled check or floor is a new question");
      await tick();
      assert.equal(calls.length, 3);
    } finally { await store.close(); }
  });
}

// Card C07g: the view the context answers as the worker starts on the new route is what the first prompt carries; the same route carries none; a refusal or an error at the start starts nothing and is checked again.
type Answer = Awaited<ReturnType<NonNullable<DispatcherDeps["routeChange"]>>> | "throw";
for (const backend of backends) {
  test(`${backend.name}: an attempt that starts on a new route carries the rebuilt view at the end of its first prompt, as the context answers it at the start; a refusal or an error at the start starts nothing`, async () => {
    const store = await backend.open();
    try {
      let current = "cloud/big";
      const w = await buildWorld(store.storage, { route: async () => choice(current) });
      const calls: string[] = [];
      // Answers given in turn, then the standing one.
      const queue: Answer[] = [];
      let answer: Answer = { ok: true, view: { text: "VIEW one", measured: true } };
      const errors: unknown[] = [];
      const dispatcher = w.restart({ routeChange: async (c) => { calls.push(`${c.previousRoute}>${c.route}`); const a = queue.shift() ?? answer; if (a === "throw") throw new Error("context down"); return a; } }, { onError: (e) => errors.push(e) });
      const ann = await w.agent("ann", workGrants(w.project, []));
      const made = await w.task("Prune roses", ann);
      const again = async (): Promise<string> => {
        const a = (await w.assignments.getAssignment(made.taskId))!;
        return (await w.assignments.admitAttempt({ commandId: `again-${Math.random().toString(36).slice(2)}`, actor: "inbox", taskId: made.taskId, expectedRevision: a.revision, generation: a.generation, owner: { kind: "agent", id: "ann" }, harness: "pi" })).id;
      };
      const tick = async (): Promise<void> => { await w.heartbeatHost(); await dispatcher.tick(); await dispatcher.idle(); };
      await tick();
      const first = w.worker.starts.at(-1)!;
      assert.equal(first.startupView, undefined, "the first attempt has no earlier route: no view");
      assert.doesNotMatch(first.content, /VIEW/);
      const base = first.content;

      // The route moves and the context accepts with a view: the view ends the first prompt, and the order says how long it is and whether the route was measured.
      current = "local/small";
      const movedId = await again();
      // The check is answered with one view, the start with another (the facts changed in between): the start's answer is the one sent.
      queue.push({ ok: true, view: { text: "VIEW at the check", measured: false } });
      await tick();
      const moved = w.worker.starts.at(-1)!;
      assert.deepEqual([moved.attemptId, moved.route], [movedId, "local/small"]);
      assert.equal(moved.content, `${base}\n\nVIEW one`);
      assert.deepEqual(moved.startupView, { route: "local/small", measured: true, chars: "\n\nVIEW one".length });
      assert.deepEqual(calls, ["cloud/big>local/small", "cloud/big>local/small"], "checked, then asked again at the start");

      // The same route again: no view, nothing asked.
      await again(); await tick();
      assert.deepEqual([w.worker.starts.at(-1)!.content, w.worker.starts.at(-1)!.startupView], [base, undefined]);
      assert.equal(calls.length, 2);

      // A move whose view is empty (nothing to show): no view part and no metadata.
      current = "cloud/big"; answer = { ok: true, view: { text: "", measured: false } };
      await again(); await tick();
      assert.deepEqual([w.worker.starts.at(-1)!.route, w.worker.starts.at(-1)!.content, w.worker.starts.at(-1)!.startupView], ["cloud/big", base, undefined]);

      // The check accepts but the start throws, then the check accepts and the start refuses: nothing starts either time, and the next pass checks again (it is not taken as remembered) and blocks.
      current = "local/small"; answer = { ok: false, reason: "essential constraints do not fit now" };
      await again();
      const startsBefore = w.worker.starts.length;
      const asked = calls.length;
      queue.push({ ok: true, view: { text: "VIEW two", measured: false } }, "throw");
      await tick();
      assert.equal(w.worker.starts.length, startsBefore, "an error at the start starts nothing");
      assert.ok(errors.some((e) => /context down/.test(String(e))), "the error is reported");
      assert.equal(calls.length, asked + 2);
      queue.push({ ok: true, view: { text: "VIEW three", measured: false } });
      await tick();
      assert.equal(w.worker.starts.length, startsBefore, "a refusal at the start starts nothing");
      assert.equal(calls.length, asked + 4, "the check after the error was asked again, not remembered");
      assert.equal(await w.blockers.openFor("dispatch_blocked", { kind: "task", id: made.taskId }), undefined, "the start's refusal waits; the check blocks");
      await tick();
      assert.equal(calls.length, asked + 5, "the check after the refusal at the start was asked again");
      assert.equal(w.worker.starts.length, startsBefore);
      const blocker = await w.blockers.openFor("dispatch_blocked", { kind: "task", id: made.taskId });
      assert.match(JSON.stringify(blocker), /essential constraints do not fit now/, "the next pass checked again and blocked");
    } finally { await store.close(); }
  });
}
