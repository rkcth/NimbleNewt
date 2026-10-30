import assert from "node:assert/strict";
import { after, test } from "node:test";
import { ResumeCheckService, type ResumePorts } from "../continuation/index.js";
import { backends, stopServer } from "../domain/testing/backends.js";
import { buildWorld, workGrants, type DispatchWorld } from "./testing/world.js";
import type { RouteResolver } from "./dispatcher.js";

after(stopServer);

// Card L04c follow-up: the dispatcher against the REAL ResumeCheckService, for the cases that wedged an attempt (a changed route, a second checkpoint, cancelled and blocked checks).
const deferred = <T>(): { promise: Promise<T>; resolve: (v: T) => void } => { let resolve!: (v: T) => void; const promise = new Promise<T>((r) => { resolve = r; }); return { promise, resolve }; };

class Fakes {
  missing: string[] = [];
  seen = new Map<string, string>();
  resolved = new Set<string>();
  opened: string[] = [];
  continuations = {
    latest: async () => ({ id: "cnt-aaaaaaaaaaaaaaaaaaaa" } as never),
    resume: async () => ({ identity: "conv", continuation: { id: "cnt-aaaaaaaaaaaaaaaaaaaa" } as never, modelChanged: false, replayed: false }),
  };
  dependencies = { check: async () => [] as never };
  blockers = {
    getBlocker: async (id: string) => ({ id, state: this.resolved.has(id) ? "resolved" : "open" }) as never,
    openBlocker: async (c: { type: string; commandId: string }) => { const old = this.seen.get(c.commandId); if (old !== undefined) return { id: old } as never; this.opened.push(c.type); const id = `blk-${this.opened.length}`; this.seen.set(c.commandId, id); return { id } as never; },
  };
  ports: ResumePorts = { observe: async () => ({}), missingContext: async () => this.missing, uncertainEffects: async () => [], review: async () => ({}) };
}

for (const backend of backends) {
  const suite = (name: string, body: (c: DispatchWorld, f: Fakes, real: ResumeCheckService, attempt: { taskId: string; attemptId: string }, withRoute: (route: () => string) => ReturnType<DispatchWorld["restart"]>) => Promise<void>) =>
    test(`${backend.name}: ${name}`, async () => {
      const store = await backend.open();
      try {
        const c = await buildWorld(store.storage);
        const f = new Fakes();
        const real = ResumeCheckService.withEpoch(store.storage, c.epoch, { continuations: f.continuations as never, dependencies: f.dependencies as never, blockers: f.blockers as never, ports: f.ports }, { clock: c.options.clock! });
        const ann = await c.agent("ann", workGrants(c.project, []));
        const { taskId, attemptId } = await c.task("long job", ann);
        // Run the attempt once and stop the controller: the attempt now has a checkpoint to resume from.
        const gate = deferred<void>();
        c.worker.script = async () => { await gate.promise; return { status: "completed", text: "late" }; };
        const first = c.restart();
        assert.deepEqual((await first.tick()).started, [attemptId]);
        await first.shutdown();
        gate.resolve(undefined);
        await first.idle();
        assert.ok((await first.get(c.owner, attemptId!))!.resumeFrom !== undefined);
        c.worker.script = async () => ({ status: "completed", text: "done" });
        const withRoute = (route: () => string) => c.restart({ resumes: real, route: (async (cmd) => { const r = await c.deps.route(cmd); return "none" in r ? r : { ...r, route: route() }; }) as RouteResolver });
        await body(c, f, real, { taskId, attemptId: attemptId! }, withRoute);
      } finally { await store.close(); }
    });

  suite("a re-chosen route is a new check: the earlier live check is cancelled and the attempt goes on (no command conflict, no 'already in progress')", async (c, f, real, a, withRoute) => {
    f.missing = ["a decision"];
    let route = "localp/small";
    let d = withRoute(() => route);
    const t1 = await d.tick();
    assert.match(t1.skipped[0]!.reason, /blocked/);
    assert.deepEqual(t1.failures, []);
    const k1 = (await real.forTask(c.dispatcherPrincipal, a.taskId))!;
    assert.equal(k1.phase, "blocked");
    route = "cloudp/big";
    f.missing = [];
    d = withRoute(() => route);
    const t2 = await d.tick();
    await d.idle();
    assert.deepEqual(t2.started, [a.attemptId], t2.skipped.map((s) => s.reason).join("; "));
    assert.equal((await real.get(c.dispatcherPrincipal, k1.id))!.phase, "cancelled", "the stale check was cancelled");
  });

  suite("a second checkpoint while an earlier check is live replaces the earlier check", async (c, f, real, a, withRoute) => {
    // An earlier checkpoint left a check of the task blocked (another key than this attempt's): the service refuses a second one while it lives.
    f.missing = ["a decision"];
    const k1 = await real.start(c.dispatcherPrincipal, { commandId: "earlier-checkpoint", taskId: a.taskId, model: { provider: "x", id: "y" }, after: "continue" });
    assert.equal(k1.phase, "blocked");
    f.missing = [];
    await assert.rejects(real.start(c.dispatcherPrincipal, { commandId: "other", taskId: a.taskId, model: { provider: "x", id: "y" }, after: "continue" }), /in progress/);
    const d = withRoute(() => "localp/small");
    const t = await d.tick();
    await d.idle();
    assert.deepEqual(t.started, [a.attemptId], t.skipped.map((s) => s.reason).join("; "));
    assert.equal((await real.get(c.dispatcherPrincipal, k1.id))!.phase, "cancelled");
  });

  suite("a cancelled check is started again, at most three times, then the owner gets a blocker", async (c, f, real, a, withRoute) => {
    f.missing = ["a decision"];
    const d = withRoute(() => "localp/small");
    for (let n = 0; n < 4; n++) {
      const t = await d.tick();
      assert.match(t.skipped[0]!.reason, /blocked|cancelled/, `round ${n}: ${t.skipped[0]?.reason}`);
      await real.cancel(c.dispatcherPrincipal, { checkId: (await real.forTask(c.dispatcherPrincipal, a.taskId))!.id });
    }
    const last = await d.tick();
    assert.match(last.skipped[0]!.reason, /cancelled 4 times; blocker .* opened/);
    assert.deepEqual(last.failures, []);
    const again = await d.tick();
    assert.match(again.skipped[0]!.reason, /cancelled 4 times/);
    assert.equal(f.opened.filter((t) => t === "dispatch_blocked").length, 0, "the dispatcher's blocker goes through the dispatcher's own service, not the check's");
  });

  suite("a blocked check whose blocker was resolved is retried by the dispatcher", async (c, f, real, a, withRoute) => {
    f.missing = ["a decision"];
    const d = withRoute(() => "localp/small");
    assert.match((await d.tick()).skipped[0]!.reason, /blocked/);
    assert.match((await d.tick()).skipped[0]!.reason, /blocked/, "an open blocker keeps it waiting");
    f.resolved.add("blk-1");
    f.missing = [];
    const t = await d.tick();
    await d.idle();
    assert.deepEqual(t.started, [a.attemptId], t.skipped.map((s) => s.reason).join("; "));
  });
}
