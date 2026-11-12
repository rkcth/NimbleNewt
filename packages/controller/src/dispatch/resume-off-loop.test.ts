import assert from "node:assert/strict";
import { after, test } from "node:test";
import { ResumeCheckService, type ResumePorts } from "../continuation/index.js";
import { backends, stopServer } from "../domain/testing/backends.js";
import { buildWorld, workGrants, type DispatchWorld } from "./testing/world.js";
import type { DispatcherDeps, DispatcherService } from "./dispatcher.js";
import type { AttemptDispatcherOptions } from "./dispatcher.js";

after(stopServer);
const CAPTURE = {
  identity: "conv-1", agent: "agent:ann", boundary: { kind: "turn-complete" as const }, checkpoint: { format: 2, conversationId: 7, at: 41, digest: `v1:sha256:${"a".repeat(64)}`, runtime: { name: "pi-durable", version: "1.3.0" } }, durable: { verified: true },
  continuation: { artifacts: [], decisions: [], pendingEffects: [], budget: { spent: 1, remaining: 9, unit: "k-tokens" }, nextStep: "run the tests" },
  manifest: { summaryLineage: [], sourceRanges: [{ source: "history", from: 1, to: 41 }], compression: { state: "none" as const, compactions: 0 }, branches: [], messageCursor: 41, routingRevision: 1, environmentRevision: 1, adapter: { name: "pi-durable", version: "1.3.0" } },
  nonCheckpointableTools: [], scratchRecords: [], credentialRefs: [],
};

// Card L04d follow-up: the model calls of a checked resume (the second agent reviewing what changed) run apart from the dispatcher's tick. A slow review does not stop other attempts from being dispatched; it is bounded
// (how long the tick waits, how many run at once, a late one reported); and nothing is lost if the process dies meanwhile, because the check is in the store and the next process asks again.
const deferred = <T>(): { promise: Promise<T>; resolve: (v: T) => void } => { let resolve!: (v: T) => void; const promise = new Promise<T>((r) => { resolve = r; }); return { promise, resolve }; };
const pause = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
/** Waits (up to 10 s) for something that happens apart from the tick, so the tests do not depend on how fast the storage is. */
const until = async (what: string, ok: () => boolean | Promise<boolean>): Promise<void> => { for (let i = 0; i < 500; i++) { if (await ok()) return; await pause(20); } throw new Error(`gave up waiting for ${what}`); };
/** Fails the test (instead of hanging it) when a tick does not come back: a tick held by a slow review is exactly the fault under test. */
const within = async <T>(ms: number, run: Promise<T>, what: string): Promise<T> => { let t: ReturnType<typeof setTimeout> | undefined; try { return await Promise.race([run, new Promise<never>((_, reject) => { t = setTimeout(() => reject(new Error(`${what} did not come back within ${ms} ms`)), ms); })]); } finally { clearTimeout(t); } };

class Fakes {
  /** Review gates by task: a task with a gate waits on it; the others are answered at once. */
  gates = new Map<string, Promise<void>>();
  reviewCalls: string[] = [];
  resumeRecorded = new Set<string>();
  continuations = {
    latest: async () => ({ id: "cnt-aaaaaaaaaaaaaaaaaaaa" } as never),
    resume: async (_by: unknown, c: { commandId: string }) => { this.resumeRecorded.add(c.commandId); return { identity: "conv", continuation: { id: "cnt-aaaaaaaaaaaaaaaaaaaa" } as never, modelChanged: false, replayed: false }; },
  };
  dependencies = { check: async () => [{ id: "dep-1", kind: "file" as const, key: "/src/a.ts", status: "changed" as never, detail: "now changed" }] as never };
  seen = new Map<string, string>();
  blockers = { getBlocker: async (id: string) => ({ id, state: "open" }) as never, openBlocker: async (c: { commandId: string }) => { const id = this.seen.get(c.commandId) ?? `blk-${this.seen.size + 1}`; this.seen.set(c.commandId, id); return { id } as never; } };
  ports: ResumePorts = {
    observe: async () => ({}), missingContext: async () => [], uncertainEffects: async () => [],
    review: async ({ taskId, changes }) => {
      this.reviewCalls.push(taskId);
      await this.gates.get(taskId);
      return Object.fromEntries(changes.map((x) => [x.id, { relevant: false, rationale: "unrelated to the task" }]));
    },
  };
}

interface Two { readonly a: { taskId: string; attemptId: string }; readonly b: { taskId: string; attemptId: string } }
for (const backend of backends) {
  const suite = (name: string, body: (c: DispatchWorld, f: Fakes, real: ResumeCheckService, t: Two, go: (extra?: Partial<DispatcherDeps>, options?: AttemptDispatcherOptions) => DispatcherService) => Promise<void>): void => {
    test(`${backend.name}: ${name}`, async () => {
      const store = await backend.open();
      try {
        const c = await buildWorld(store.storage);
        const f = new Fakes();
        const real = ResumeCheckService.withEpoch(store.storage, c.epoch, { continuations: f.continuations as never, dependencies: f.dependencies as never, blockers: f.blockers as never, ports: f.ports }, { clock: c.options.clock! });
        const ann = await c.agent("ann", workGrants(c.project, []));
        const bob = await c.agent("bob", workGrants(c.project, []));
        const a = await c.task("slow review", ann);
        const b = await c.task("quick review", bob);
        const gate = deferred<void>();
        c.worker.script = async () => { await gate.promise; return { status: "completed", text: "late" }; };
        const first = c.restart();
        assert.deepEqual([...(await first.tick()).started].sort(), [a.attemptId, b.attemptId].sort());
        await first.shutdown();
        gate.resolve(undefined);
        await first.idle();
        for (const x of [a, b]) assert.ok((await first.get(c.owner, x.attemptId!))!.resumeFrom !== undefined, "the attempt has a checkpoint to resume from");
        c.worker.script = async () => ({ status: "completed", text: "done" });
        await body(c, f, real, { a: { taskId: a.taskId, attemptId: a.attemptId! }, b: { taskId: b.taskId, attemptId: b.attemptId! } }, (extra = {}, options = {}) => c.restart({ resumes: real, ...extra }, options));
      } finally { await store.close(); }
    });
  };

  suite("a slow review does not hold the tick: the other attempt is dispatched while it runs, and the slow one starts once it ends", async (c, f, real, t, go) => {
    const gate = deferred<void>();
    f.gates.set(t.a.taskId, gate.promise);
    const d = go({}, { resumeInlineMs: 30 });
    // Every tick comes back although the review of the first attempt never ends; the second attempt is dispatched meanwhile (how many ticks that takes depends on the storage), and the slow one only waits.
    const started: string[] = [];
    let waiting: { check: string; reason: string } | undefined;
    for (let i = 0; i < 40 && !started.includes(t.b.attemptId); i++) {
      const tick = await within(5000, d.tick(), "the tick");
      started.push(...tick.started);
      assert.deepEqual(tick.failures, []);
      waiting = tick.skipped.find((s) => s.attemptId === t.a.attemptId) ?? waiting;
      await pause(20);
    }
    assert.deepEqual(started, [t.b.attemptId], "the quick one started while the slow review ran, and the slow one did not");
    assert.equal(waiting!.check, "resume");
    assert.match(waiting!.reason, /being run apart from the tick/);
    await until("the slow review to be asked", () => f.reviewCalls.includes(t.a.taskId));
    assert.deepEqual(f.reviewCalls.filter((x) => x === t.a.taskId).length, 1, "one review in flight, not one per tick");
    gate.resolve(undefined);
    await d.idle();
    const t3 = await d.tick();
    await d.idle();
    assert.deepEqual(t3.started, [t.a.attemptId], t3.skipped.map((s) => s.reason).join("; "));
    assert.equal((await real.forTask(c.dispatcherPrincipal, t.a.taskId))!.phase, "done");
    assert.equal(f.resumeRecorded.size, 2, "one resume recorded for each attempt");
  });

  suite("a review that ends inside the short inline wait is used in the same tick, as before", async (c, f, real, t, go) => {
    const d = go({}, { resumeInlineMs: 2000 });
    const t1 = await within(5000, d.tick(), "the tick");
    await d.idle();
    assert.deepEqual([...t1.started].sort(), [t.a.attemptId, t.b.attemptId].sort(), t1.skipped.map((s) => s.reason).join("; "));
    void real;
  });

  suite("a crash while a review runs loses nothing: the next process finds the check in the store, asks again, and the resume is recorded once", async (c, f, real, t, go) => {
    const gate = deferred<void>();
    f.gates.set(t.a.taskId, gate.promise);
    const died = go({}, { resumeInlineMs: 0 });
    const t1 = await within(5000, died.tick(), "the tick");
    assert.ok(t1.skipped.some((s) => s.attemptId === t.a.attemptId && /apart from the tick/.test(s.reason)));
    for (let i = 0; i < 100 && !f.reviewCalls.includes(t.a.taskId); i++) await pause(20);
    const check = (await real.forTask(c.dispatcherPrincipal, t.a.taskId))!;
    assert.equal(check.phase, "reviewing", "the check is in the store, mid-review");
    // `died` is never used again (the process is gone, and with it the service's memory of a review in flight). A new process, with a service of its own over the same store, asks again.
    const real2 = ResumeCheckService.withEpoch(c.storage, c.epoch, { continuations: f.continuations as never, dependencies: f.dependencies as never, blockers: f.blockers as never, ports: f.ports }, { clock: c.options.clock! });
    const next = go({ resumes: real2 }, { resumeInlineMs: 0 });
    const t2 = await within(5000, next.tick(), "the new process's tick");
    assert.ok(t2.skipped.some((s) => s.attemptId === t.a.attemptId && /apart from the tick/.test(s.reason)));
    await until("the new process to ask again", () => f.reviewCalls.filter((x) => x === t.a.taskId).length >= 2);
    assert.equal(f.reviewCalls.filter((x) => x === t.a.taskId).length, 2, "the new process asked again");
    gate.resolve(undefined);
    await next.idle();
    const t3 = await next.tick();
    await next.idle();
    assert.ok(t3.started.includes(t.a.attemptId), t3.skipped.map((s) => s.reason).join("; "));
    assert.equal((await real.forTask(c.dispatcherPrincipal, t.a.taskId))!.phase, "done");
    assert.equal([...f.resumeRecorded].filter((id) => id.startsWith(`${check.id}`)).length, 1, "recorded once under the check's own command ID");
  });

  suite("the resume sweep (a loop of the tick) runs apart too: a check left mid-review by a dead process is carried on without holding the tick, and is asked once", async (c, f, real, t, go) => {
    // A process that died mid-review: its check is in the store, in review, for a task this process does not dispatch now (so only the sweep reaches it).
    const gate = deferred<void>();
    f.gates.set(t.a.taskId, gate.promise);
    void real.start(c.dispatcherPrincipal, { commandId: "left-over", taskId: t.a.taskId, attemptId: t.a.attemptId, model: { provider: "local", id: "m1" }, after: "restart" }).catch(() => undefined);
    const askedA = (): number => f.reviewCalls.filter((x) => x === t.a.taskId).length;
    await until("the dead process's review to be asked", () => askedA() >= 1);
    const real2 = ResumeCheckService.withEpoch(c.storage, c.epoch, { continuations: f.continuations as never, dependencies: f.dependencies as never, blockers: f.blockers as never, ports: f.ports }, { clock: c.options.clock! });
    const d = go({ resumes: real2, heldBy: async (id) => (id === t.a.taskId ? "held for the test" : undefined), loops: [{ name: "resumes.sweep", apart: true, run: (by) => real2.sweep(by) }] }, { resumeInlineMs: 30 });
    const started: string[] = [];
    for (let i = 0; i < 40 && !started.includes(t.b.attemptId); i++) {
      const tick = await within(5000, d.tick(), "the tick");
      started.push(...tick.started);
      assert.ok(tick.loops.every((l) => l.ok), JSON.stringify(tick.loops));
      await pause(20);
    }
    assert.deepEqual(started, [t.b.attemptId], "the other task started while the sweep waited for the model");
    await until("the sweep to ask again", () => askedA() >= 2);
    for (let i = 0; i < 3; i++) await within(5000, d.tick(), "a later tick");
    assert.equal(askedA(), 2, "the sweep is not started again while it runs: asked by the dead process and once by the sweep");
    gate.resolve(undefined);
    await d.idle();
    await until("the check to be ready", async () => (await real2.forTask(c.dispatcherPrincipal, t.a.taskId))?.phase === "ready");
  });

  suite("at most resumeJobsMax reviews run at once; the others wait for a free place and lose nothing", async (c, f, real, t, go) => {
    const gate = deferred<void>();
    f.gates.set(t.a.taskId, gate.promise);
    f.gates.set(t.b.taskId, gate.promise);
    const d = go({}, { resumeInlineMs: 0, resumeJobsMax: 1 });
    const t1 = await within(5000, d.tick(), "the tick");
    const reasons = t1.skipped.map((s) => s.reason);
    assert.equal(reasons.filter((r) => /being run apart from the tick/.test(r)).length, 1, reasons.join("; "));
    assert.equal(reasons.filter((r) => /1 resume checks are already being run; this one waits for a free place/.test(r)).length, 1, reasons.join("; "));
    await until("the one review to be asked", () => f.reviewCalls.length >= 1);
    await pause(150);
    assert.equal(f.reviewCalls.length, 1, "only one model call is in flight");
    gate.resolve(undefined);
    await d.idle();
    const started: string[] = [];
    const why: string[] = [];
    for (let i = 0; i < 6 && started.length < 2; i++) { const r = await d.tick(); started.push(...r.started); why.push(...r.skipped.map((s) => s.reason)); await d.idle(); }
    assert.equal(started.length, 2, why.join(" | "));
    assert.deepEqual([...started].sort(), [t.a.attemptId, t.b.attemptId].sort(), "both started in the end");
    void real;
  });

  suite("a review past its bound is reported once and still waited for; a fault after the inline wait is reported, and the attempt is not failed", async (c, f, real, t, go) => {
    const gate = deferred<void>();
    f.gates.set(t.a.taskId, gate.promise);
    f.gates.set(t.b.taskId, gate.promise);
    const errors: string[] = [];
    const d = go({}, { resumeInlineMs: 0, resumeJobMs: 5, onError: (e) => errors.push(e instanceof Error ? e.message : String(e)) });
    await d.tick();
    await pause(30);
    const t2 = await d.tick();
    await d.tick();
    assert.equal(errors.filter((e) => /for more than \d+ seconds; it is still waited for/.test(e)).length, 2, `one report per late review, not per tick: ${errors.join(" | ")}`);
    assert.ok(t2.skipped.every((s) => /longer than expected/.test(s.reason)), t2.skipped.map((s) => s.reason).join("; "));
    assert.deepEqual(t2.failures, []);
    gate.resolve(undefined);
    await d.idle();
    void real;
  });

  suite("a fault in the check is a wait whether it comes inside the inline wait or after it; the attempt is not failed", async (c, f, real, t, go) => {
    const errors: string[] = [];
    let fail = true;
    const flaky = new Proxy(real, { get: (target, prop) => {
      if (prop === "start") return async (...args: Parameters<ResumeCheckService["start"]>) => { if (fail) { await pause(40); throw new Error("the store hiccuped"); } return target.start(...args); };
      const v = Reflect.get(target, prop) as unknown;
      return typeof v === "function" ? (v as (...a: unknown[]) => unknown).bind(target) : v;
    } }) as ResumeCheckService;
    // Inside the wait: answered as a wait with the reason.
    const inside = go({ resumes: flaky }, { resumeInlineMs: 2000, onError: (e) => errors.push(String(e)) });
    const t1 = await within(5000, inside.tick(), "the tick");
    assert.ok(t1.skipped.some((s) => s.attemptId === t.a.attemptId && /the resume check could not be run: .*the store hiccuped/.test(s.reason)), t1.skipped.map((s) => s.reason).join("; "));
    assert.deepEqual(t1.failures, []);
    // After it: reported through onError, and the next tick (the store is well again) goes on.
    const outside = go({ resumes: flaky }, { resumeInlineMs: 0, onError: (e) => errors.push(String(e)) });
    await outside.tick();
    await pause(120);
    assert.ok(errors.some((e) => /the store hiccuped/.test(e)), errors.join(" | "));
    fail = false;
    const started: string[] = [];
    for (let i = 0; i < 8 && started.length < 2; i++) { started.push(...(await outside.tick()).started); await outside.idle(); }
    assert.deepEqual([...started].sort(), [t.a.attemptId, t.b.attemptId].sort());
  });
}
