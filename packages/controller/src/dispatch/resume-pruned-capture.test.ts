import assert from "node:assert/strict";
import { after, test } from "node:test";
import { CONTINUATION_KEEP, ContinuationService, ResumeCheckService, controllerResumePorts, type ContinuationInput } from "../continuation/index.js";
import { DependencyService } from "../dependencies/index.js";
import { backends, stopServer } from "../domain/testing/backends.js";
import { buildWorld, workGrants } from "./testing/world.js";

after(stopServer);

// Card L04d (follow-ups, tests only): the dispatcher's commit of a resume check whose capture is pruned while the check is in progress (more than CONTINUATION_KEEP newer captures).
const dg = (n: number): string => `v1:sha256:${n.toString(16).padStart(64, "0")}`;
const PI = (n: number): Record<string, unknown> => ({ pi: { conversationId: 1, at: n, digest: dg(n), runtime: { name: "pi", version: "1" }, format: 1 } });
let counter = 0;
const cid = (label: string): string => `${label}-${counter++}`;
const input = (n: number): ContinuationInput => ({
  identity: "conv-1", agent: "agent:ann", boundary: { kind: "turn-complete" },
  checkpoint: { conversationId: 1, at: n, digest: dg(n), runtime: { name: "pi", version: "1" }, format: 1 },
  durable: { verified: true },
  continuation: { artifacts: [], decisions: [], pendingEffects: [], budget: { spent: 0, remaining: 0, unit: "x" }, nextStep: "carry on" },
  manifest: { summaryLineage: [], sourceRanges: [], compression: { state: "none", compactions: 0 }, branches: [], messageCursor: n, routingRevision: 0, environmentRevision: 0, adapter: { name: "pi", version: "1" } },
  nonCheckpointableTools: [], scratchRecords: [], credentialRefs: [],
});

for (const backend of backends) {
  test(`${backend.name}: a resume check whose capture is pruned before the resume is recorded answers not_found, starts the check over, and the dispatcher commits it on the next tick so the attempt starts`, async () => {
    const store = await backend.open();
    try {
      const c = await buildWorld(store.storage);
      const options = { clock: c.options.clock! };
      const continuations = ContinuationService.withEpoch(store.storage, c.epoch, options);
      const dependencies = DependencyService.withEpoch(store.storage, c.epoch, options);
      let prune = true;
      const attempts: string[] = [];
      const racing = new Proxy(continuations, { get: (target, prop) => {
        const v = Reflect.get(target, prop) as unknown;
        if (prop === "resume") return async (...args: unknown[]) => {
          attempts.push("resume");
          if (prune) { prune = false; for (let i = 0; i < CONTINUATION_KEEP + 1; i++) await continuations.capture(c.owner, { commandId: cid("c"), taskId: taskIdOf, ...input(100 + i) }); }
          return (target.resume as (...a: unknown[]) => unknown).apply(target, args);
        };
        return typeof v === "function" ? (v as (...a: unknown[]) => unknown).bind(target) : v;
      } }) as ContinuationService;
      const real = ResumeCheckService.withEpoch(store.storage, c.epoch, { continuations: racing, dependencies, blockers: c.blockers, ports: controllerResumePorts(store.storage, { observe: async () => ({}), review: async () => ({}) }) }, options);
      const ann = await c.agent("ann", workGrants(c.project, []));
      const { taskId, attemptId } = await c.task("long job", ann);
      const taskIdOf = taskId;
      // Two captures; the attempt's own checkpoint is the older one, so the check follows it and it is not the latest complete capture.
      const first = await continuations.capture(c.owner, { commandId: cid("c"), taskId, ...input(1) });
      await continuations.capture(c.owner, { commandId: cid("c"), taskId, ...input(2) });
      let release!: () => void;
      const gate = new Promise<void>((r) => { release = r; });
      c.worker.script = async ({ worker }) => { worker.checkpoint = async () => PI(1) as never; await gate; return { status: "completed", text: "late" }; };
      const firstRun = c.restart();
      assert.deepEqual((await firstRun.tick()).started, [attemptId]);
      await firstRun.shutdown();
      release();
      await firstRun.idle();
      assert.ok((await firstRun.get(c.owner, attemptId!))!.resumeFrom !== undefined);
      c.worker.script = async () => ({ status: "completed", text: "done" });
      const starts = c.worker.starts.length;

      const d = c.restart({ resumes: real });
      const held = await d.tick();
      assert.deepEqual(held.started, [], "the attempt does not start on a commit that did not finish");
      assert.match(held.skipped.map((s) => s.reason).join("; "), /resume check .* is ready after the commit; it is looked at again on the next tick/, JSON.stringify(held.skipped));
      assert.equal(await store.storage.getAggregate({ kind: "continuation", id: first.id }), undefined, "the capture the check followed was pruned");
      assert.equal((await store.storage.listAggregates("continuation-resume", { limit: 10 })).length, 0, "no resume was recorded against a missing capture");
      assert.equal(c.worker.starts.length, starts);
      assert.equal(attempts.length, 1, "the resume was tried once");
      // The next tick commits the check again, now against the capture that exists, and the attempt starts.
      const again = await d.tick();
      await d.idle();
      assert.deepEqual(again.started, [attemptId], JSON.stringify(again.skipped));
      assert.equal((await real.forTask(c.dispatcherPrincipal, taskId))?.phase, "done");
      assert.equal((await store.storage.listAggregates("continuation-resume", { limit: 10 })).length, 1);
      assert.equal(c.worker.starts.length, starts + 1);
    } finally { await store.close(); }
  });

  // T8 second review: the attempt ended (the task was released) while its capture was pruned, before the resume was recorded. The resume answers not_found (the capture is looked up before the
  // attempt), and the check ends cancelled as it does when the capture still exists: never started over for an attempt that will not run, and never a churn blocker for it.
  for (const lastRound of [false, true]) {
    test(`${backend.name}: a check whose attempt was released while its capture was pruned ends cancelled, not started over${lastRound ? " (in its last round: no churn blocker)" : ""}`, async () => {
      const store = await backend.open();
      try {
        const c = await buildWorld(store.storage);
        const options = { clock: c.options.clock!, ...(lastRound ? { maxRounds: 1 } : {}) };
        const continuations = ContinuationService.withEpoch(store.storage, c.epoch, { clock: c.options.clock! });
        const dependencies = DependencyService.withEpoch(store.storage, c.epoch, { clock: c.options.clock! });
        const ann = await c.agent("ann", workGrants(c.project, []));
        const { taskId, attemptId } = await c.task("long job", ann);
        let prune = true;
        const racing = new Proxy(continuations, { get: (target, prop) => {
          const v = Reflect.get(target, prop) as unknown;
          if (prop === "resume") return async (...args: unknown[]) => {
            if (prune) {
              prune = false;
              for (let i = 0; i < CONTINUATION_KEEP + 1; i++) await continuations.capture(c.owner, { commandId: cid("c"), taskId, ...input(100 + i) });
              const asg = (await c.assignments.getAssignment(taskId))!;
              await c.assignments.releaseTask({ commandId: cid("rel"), actor: c.owner.id, taskId, expectedRevision: asg.revision });
            }
            return (target.resume as (...a: unknown[]) => unknown).apply(target, args);
          };
          return typeof v === "function" ? (v as (...a: unknown[]) => unknown).bind(target) : v;
        } }) as ContinuationService;
        const opened: string[] = [];
        const blockers = new Proxy(c.blockers, { get: (target, prop) => {
          const v = Reflect.get(target, prop) as unknown;
          if (prop === "openBlocker") return async (...args: unknown[]) => { opened.push(String((args[0] as { type?: string }).type)); return (v as (...a: unknown[]) => unknown).apply(target, args); };
          return typeof v === "function" ? (v as (...a: unknown[]) => unknown).bind(target) : v;
        } }) as typeof c.blockers;
        const real = ResumeCheckService.withEpoch(store.storage, c.epoch, { continuations: racing, dependencies, blockers, ports: controllerResumePorts(store.storage, { observe: async () => ({}), review: async () => ({}) }) }, options);
        const first = await continuations.capture(c.owner, { commandId: cid("c"), taskId, ...input(1) });
        await continuations.capture(c.owner, { commandId: cid("c"), taskId, ...input(2) });
        const own = await real.start(c.owner, { commandId: cid("s"), taskId, attemptId: attemptId!, model: { provider: "local", id: "m1" }, after: "continue", checkpointDigest: dg(1) });
        assert.equal(own.phase, "ready");
        assert.equal(own.continuationId, first.id);
        if (lastRound) assert.equal(own.round + 1, own.maxRounds, "the check is in its last round");
        const after = await real.commit(c.owner, { commandId: cid("k"), checkId: own.id });
        assert.equal(await store.storage.getAggregate({ kind: "continuation", id: first.id }), undefined, "the capture was pruned");
        assert.equal(after.phase, "cancelled", JSON.stringify(after.history));
        assert.equal(after.round, own.round, "not started over");
        assert.equal((await store.storage.listAggregates("continuation-resume", { limit: 10 })).length, 0, "nothing recorded");
        assert.deepEqual(opened, [], "no blocker opened");
        assert.equal((await real.advance(c.owner, { checkId: own.id })).phase, "cancelled", "repeatable");
      } finally { await store.close(); }
    });
  }

  // T8b (a): the attempt ends in the middle of the write that blocks a check as churn, after its blocker was opened. The check ends cancelled; the blocker must not stay open for a check nobody will carry on.
  test(`${backend.name}: a check whose attempt ends while its churn block is being written ends cancelled and its blocker is closed`, async () => {
    const store = await backend.open();
    try {
      const c = await buildWorld(store.storage);
      const options = { clock: c.options.clock!, maxRounds: 1 };
      const continuations = ContinuationService.withEpoch(store.storage, c.epoch, { clock: c.options.clock! });
      const dependencies = DependencyService.withEpoch(store.storage, c.epoch, { clock: c.options.clock! });
      const ann = await c.agent("ann", workGrants(c.project, []));
      const { taskId, attemptId } = await c.task("long job", ann);
      let prune = true;
      const racing = new Proxy(continuations, { get: (target, prop) => {
        const v = Reflect.get(target, prop) as unknown;
        if (prop === "resume") return async (...args: unknown[]) => {
          if (prune) { prune = false; for (let i = 0; i < CONTINUATION_KEEP + 1; i++) await continuations.capture(c.owner, { commandId: cid("c"), taskId, ...input(100 + i) }); }
          return (target.resume as (...a: unknown[]) => unknown).apply(target, args);
        };
        return typeof v === "function" ? (v as (...a: unknown[]) => unknown).bind(target) : v;
      } }) as ContinuationService;
      const opened: string[] = [];
      const blockers = new Proxy(c.blockers, { get: (target, prop) => {
        const v = Reflect.get(target, prop) as unknown;
        if (prop === "openBlocker") return async (...args: unknown[]) => {
          const r = await (v as (...a: unknown[]) => Promise<unknown>).apply(target, args);
          opened.push(String((args[0] as { type?: string }).type));
          const asg = (await c.assignments.getAssignment(taskId))!;
          await c.assignments.releaseTask({ commandId: cid("rel"), actor: c.owner.id, taskId, expectedRevision: asg.revision });
          return r;
        };
        return typeof v === "function" ? (v as (...a: unknown[]) => unknown).bind(target) : v;
      } }) as typeof c.blockers;
      const real = ResumeCheckService.withEpoch(store.storage, c.epoch, { continuations: racing, dependencies, blockers, ports: controllerResumePorts(store.storage, { observe: async () => ({}), review: async () => ({}) }) }, options);
      await continuations.capture(c.owner, { commandId: cid("c"), taskId, ...input(1) });
      await continuations.capture(c.owner, { commandId: cid("c"), taskId, ...input(2) });
      const own = await real.start(c.owner, { commandId: cid("s"), taskId, attemptId: attemptId!, model: { provider: "local", id: "m1" }, after: "continue", checkpointDigest: dg(1) });
      assert.equal(own.round + 1, own.maxRounds, "the check is in its last round");
      const after = await real.commit(c.owner, { commandId: cid("k"), checkId: own.id });
      assert.deepEqual(opened, ["resume_churn"], "the churn blocker was opened");
      assert.equal(after.phase, "cancelled", JSON.stringify(after.history));
      assert.equal(await c.blockers.openFor("resume_churn", { kind: "task", id: taskId }), undefined, "no churn blocker stays open for it");
      assert.equal((await c.blockers.occurrences("resume_churn", { kind: "task", id: taskId })), 1, "the blocker existed and was closed");
      const closed = (await store.storage.listAggregates("blocker", { limit: 100 })).filter((b) => b.body["type"] === "resume_churn");
      assert.equal(closed.length, 1);
      assert.match(String(closed[0]!.body["resolution"]), /attempt this resume check was for ended before the check could be blocked/, "the resolution says why");
      assert.equal((await real.advance(c.owner, { checkId: own.id })).phase, "cancelled", "repeatable");
    } finally { await store.close(); }
  });

  // T8b review: the same, but a second advance of the check blocks it with that very blocker (opened once per task) before the attempt ends, while the first one's write is under way. The first
  // write is refused (the attempt ended) and the check names the blocker: it stays open, for the owner to look at.
  test(`${backend.name}: a churn blocker the check names is not closed when another advance of it is refused because the attempt ended`, async () => {
    const store = await backend.open();
    try {
      const c = await buildWorld(store.storage);
      const options = { clock: c.options.clock!, maxRounds: 1 };
      const continuations = ContinuationService.withEpoch(store.storage, c.epoch, { clock: c.options.clock! });
      const dependencies = DependencyService.withEpoch(store.storage, c.epoch, { clock: c.options.clock! });
      const ann = await c.agent("ann", workGrants(c.project, []));
      const { taskId, attemptId } = await c.task("long job", ann);
      let prune = true;
      const racing = new Proxy(continuations, { get: (target, prop) => {
        const v = Reflect.get(target, prop) as unknown;
        if (prop === "resume") return async (...args: unknown[]) => {
          if (prune) { prune = false; for (let i = 0; i < CONTINUATION_KEEP + 1; i++) await continuations.capture(c.owner, { commandId: cid("c"), taskId, ...input(100 + i) }); }
          return (target.resume as (...a: unknown[]) => unknown).apply(target, args);
        };
        return typeof v === "function" ? (v as (...a: unknown[]) => unknown).bind(target) : v;
      } }) as ContinuationService;
      // 0: idle; 1: the first advance opened the churn blocker; 2: the second advance runs, then the task is released.
      let state = 0; let real!: ResumeCheckService; let checkId = ""; let second: unknown;
      const blockers = new Proxy(c.blockers, { get: (target, prop) => {
        const v = Reflect.get(target, prop) as unknown;
        if (prop === "openBlocker") return async (...args: unknown[]) => { const r = await (v as (...a: unknown[]) => Promise<unknown>).apply(target, args); if (state === 0) state = 1; return r; };
        return typeof v === "function" ? (v as (...a: unknown[]) => unknown).bind(target) : v;
      } }) as typeof c.blockers;
      // The first advance's block write reads the check (still executing); just then the second advance blocks it, and the task is released before the first write is made.
      const late = new Proxy(store.storage, { get: (target, prop) => {
        const v = Reflect.get(target, prop) as unknown;
        if (prop === "getAggregate") return async (ref: { kind: string; id: string }) => {
          const r = await (target.getAggregate as (r: unknown) => Promise<unknown>).call(target, ref);
          if (state === 1 && ref.kind === "resume-check") {
            state = 2;
            // The dispatcher's principal, so its block is not the very same write as the first advance's (which would then answer as already made).
            second = await real.advance(c.dispatcherPrincipal, { checkId });
            const asg = (await c.assignments.getAssignment(taskId))!;
            await c.assignments.releaseTask({ commandId: cid("rel"), actor: c.owner.id, taskId, expectedRevision: asg.revision });
          }
          return r;
        };
        return typeof v === "function" ? (v as (...a: unknown[]) => unknown).bind(target) : v;
      } }) as typeof store.storage;
      real = ResumeCheckService.withEpoch(late, c.epoch, { continuations: racing, dependencies, blockers, ports: controllerResumePorts(store.storage, { observe: async () => ({}), review: async () => ({}) }) }, options);
      await continuations.capture(c.owner, { commandId: cid("c"), taskId, ...input(1) });
      await continuations.capture(c.owner, { commandId: cid("c"), taskId, ...input(2) });
      const own = await real.start(c.owner, { commandId: cid("s"), taskId, attemptId: attemptId!, model: { provider: "local", id: "m1" }, after: "continue", checkpointDigest: dg(1) });
      checkId = own.id;
      assert.equal(own.round + 1, own.maxRounds, "the check is in its last round");
      const after = await real.commit(c.owner, { commandId: cid("k"), checkId: own.id });
      assert.equal(state, 2, "the second advance ran inside the first one's write");
      assert.equal((second as { phase?: string }).phase, "blocked", "the second advance blocked the check");
      assert.equal(after.phase, "blocked", JSON.stringify(after.history));
      assert.equal(after.blocked?.type, "resume_churn");
      const open = await c.blockers.openFor("resume_churn", { kind: "task", id: taskId });
      assert.equal(open?.id, after.blocked?.blockerId, "the blocker the check names stays open");
      assert.equal(await c.blockers.occurrences("resume_churn", { kind: "task", id: taskId }), 1, "one blocker, shared by both advances");
    } finally { await store.close(); }
  });

  // T8b second review: the check's churn blocker is opened, and before the block is written something else happens to the check: its resume is recorded by another advance (the pruned-capture
  // start over in its last round), or the dispatcher cancels it because its attempt ended (a commit's start over, which carries no attempt guard), or it is cancelled and the task's newer check,
  // for a new attempt, blocks as churn with that same open blocker (blockers are one per task and type). The block is not written; a blocker no check names is closed with a true resolution, one a
  // check names stays open.
  for (const meanwhile of ["recorded", "cancelled", "newer check"] as const) {
    test(`${backend.name}: a churn blocker opened for a block that is not written (${meanwhile} meanwhile) is ${meanwhile === "newer check" ? "kept for the newer check that names it" : "closed"}`, async () => {
      const store = await backend.open();
      try {
        const c = await buildWorld(store.storage);
        const continuations = ContinuationService.withEpoch(store.storage, c.epoch, { clock: c.options.clock! });
        const dependencies = DependencyService.withEpoch(store.storage, c.epoch, { clock: c.options.clock! });
        const ann = await c.agent("ann", workGrants(c.project, []));
        const { taskId, attemptId } = await c.task("long job", ann);
        const model = { provider: "local", id: "m1" };
        let prune = meanwhile === "recorded"; let checkId = ""; let real!: ResumeCheckService; let fired = false; let newer: Awaited<ReturnType<ResumeCheckService["commit"]>> | undefined;
        const racing = new Proxy(continuations, { get: (target, prop) => {
          const v = Reflect.get(target, prop) as unknown;
          if (prop === "resume") return async (...args: unknown[]) => {
            if (prune) { prune = false; for (let i = 0; i < CONTINUATION_KEEP + 1; i++) await continuations.capture(c.owner, { commandId: cid("c"), taskId, ...input(100 + i) }); }
            return (target.resume as (...a: unknown[]) => unknown).apply(target, args);
          };
          return typeof v === "function" ? (v as (...a: unknown[]) => unknown).bind(target) : v;
        } }) as ContinuationService;
        const blockers = new Proxy(c.blockers, { get: (target, prop) => {
          const v = Reflect.get(target, prop) as unknown;
          if (prop === "openBlocker") return async (...args: unknown[]) => {
            const r = await (v as (...a: unknown[]) => Promise<unknown>).apply(target, args);
            if (fired) return r;
            fired = true;
            if (meanwhile === "recorded") {
              // Another advance of the check records its resume (the check's own command ID, against the capture that exists).
              const latest = (await continuations.latest(c.owner, taskId))!;
              await continuations.resume({ id: "service:resume-check", kind: "service", name: "resume-check", grants: [] }, { commandId: `${checkId}-resume`, taskId, continuationId: latest.id, model, after: "continue" });
              return r;
            }
            const asg = (await c.assignments.getAssignment(taskId))!;
            await c.assignments.releaseTask({ commandId: cid("rel"), actor: c.owner.id, taskId, expectedRevision: asg.revision });
            await real.cancel(c.dispatcherPrincipal, { checkId, reason: "attempt-ended" });
            if (meanwhile === "newer check") {
              await c.assignments.assignTask({ commandId: cid("as"), actor: c.owner.id, taskId, owner: { kind: "agent", id: ann.aid }, expectedRevision: (await c.assignments.getAssignment(taskId))!.revision });
              const a2 = (await c.assignments.getAssignment(taskId))!;
              const att2 = await c.assignments.admitAttempt({ commandId: cid("ad"), actor: "inbox", taskId, expectedRevision: a2.revision, generation: a2.generation, owner: { kind: "agent", id: ann.aid }, harness: "pi" });
              const next = await real.start(c.owner, { commandId: cid("s"), taskId, attemptId: att2.id, model, after: "continue" });
              assert.equal(next.phase, "ready", JSON.stringify(next.history));
              await continuations.capture(c.owner, { commandId: cid("c"), taskId, ...input(4) });
              newer = await real.commit(c.owner, { commandId: cid("k"), checkId: next.id });
            }
            return r;
          };
          return typeof v === "function" ? (v as (...a: unknown[]) => unknown).bind(target) : v;
        } }) as typeof c.blockers;
        real = ResumeCheckService.withEpoch(store.storage, c.epoch, { continuations: racing, dependencies, blockers, ports: controllerResumePorts(store.storage, { observe: async () => ({}), review: async () => ({}) }) }, { clock: c.options.clock!, maxRounds: 1 });
        await continuations.capture(c.owner, { commandId: cid("c"), taskId, ...input(1) });
        await continuations.capture(c.owner, { commandId: cid("c"), taskId, ...input(2) });
        const own = await real.start(c.owner, { commandId: cid("s"), taskId, attemptId: attemptId!, model, after: "continue", ...(meanwhile === "recorded" ? { checkpointDigest: dg(1) } : {}) });
        checkId = own.id;
        assert.equal(own.phase, "ready");
        assert.equal(own.round + 1, own.maxRounds, "the check is in its last round");
        // A capture after the review makes the commit start the check over (pruned: inside the resume).
        if (meanwhile !== "recorded") await continuations.capture(c.owner, { commandId: cid("c"), taskId, ...input(3) });
        const after = await real.commit(c.owner, { commandId: cid("k"), checkId: own.id });
        assert.ok(fired, "the churn blocker was opened");
        assert.equal(after.phase, meanwhile === "recorded" ? "done" : "cancelled", JSON.stringify(after.history));
        assert.equal(after.blocked, undefined);
        const churn = (await store.storage.listAggregates("blocker", { limit: 100 })).filter((b) => b.body["type"] === "resume_churn");
        assert.equal(churn.length, 1);
        const first = await c.blockers.getBlocker(churn[0]!.id);
        assert.equal(await c.blockers.occurrences("resume_churn", { kind: "task", id: taskId }), 1, "one churn blocker existed");
        if (meanwhile === "newer check") {
          assert.equal(newer?.phase, "blocked", JSON.stringify(newer?.history));
          assert.equal(newer?.blocked?.type, "resume_churn");
          assert.equal(newer?.blocked?.blockerId, first?.id, "the newer check was given the same open blocker");
          assert.equal(first?.state, "open", "the blocker the newer check names stays open");
          assert.equal(await real.retryable((await real.get(c.owner, newer!.id))!), false, "the newer check still waits for the owner");
        } else {
          assert.equal(first?.state, "resolved", "no churn blocker stays open for a check that does not name it");
          assert.match(String(first?.resolution), meanwhile === "recorded" ? /resume was recorded before the check could be blocked/ : /moved on \(it was committed, cancelled or blocked for another reason\)/);
          assert.equal(await c.blockers.openFor("resume_churn", { kind: "task", id: taskId }), undefined);
          assert.equal((await real.advance(c.owner, { checkId: own.id })).phase, after.phase, "repeatable");
        }
      } finally { await store.close(); }
    });
  }
}
