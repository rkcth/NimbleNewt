import assert from "node:assert/strict";
import { after, test } from "node:test";
import { DomainError } from "@nimblenewt/controller";
import { isCrash, Chaos, Clock, Crash, acknowledgedSurvive, describe, engines, openStore, pickIndexes, runChild, startProcess, stopServer, withEngine, type Clean, type SliceWorld } from "./g04-fixture.js";
import { DEADLINE, checkWaits, cleanWaitRun, openWaits, settleWaits, waitAuditCounts, waitScenario, waitServices, waitSignature } from "./g04-wait.js";

/**
 * Card G04, waits and service restarts. The services are the production S08 `WaitService` and `Reconciler`; the database is real. A wait is a record plus a
 * timer in the same transaction as the task's blocking, so it must be exactly there after any restart, must not be resolved by the restart itself, and must be
 * settled exactly once when its deadline passes, whenever the process dies.
 */
export function defineWaitTests(engineName: string): void {
  const engine = engines.find((e) => e.name === engineName)!;
  after(stopServer);

  test(`${engine.name}: a wait survives a restart of the service: still open, task still blocked, not resolved by the restart; settled exactly once after its deadline; a stale service cannot answer`, async () => {
    await withEngine(engine, async (spec, dir) => {
      const storage = await openStore(spec);
      try {
        const clock = new Clock();
        const world: SliceWorld = { storage, directory: dir, chaos: new Chaos(), clock: clock.now };
        const first = await startProcess(world, "service-1");
        const services1 = waitServices(first, world);
        const opened = await openWaits(first, services1);

        // The restart: a new epoch and new service objects. Nothing is carried over in memory.
        clock.advance(5_000);
        const second = await startProcess(world, "service-2");
        const services2 = waitServices(second, world);
        assert.ok(second.projects.epoch > first.projects.epoch);
        for (const [id, deadline] of [[opened.a, undefined], [opened.b, DEADLINE]] as const) {
          const wait = await services2.waits.getWait(id);
          assert.equal(wait?.state, "open");
          assert.equal(wait?.deadline, deadline);
        }
        assert.equal((await second.projects.getTask(opened.taskA))?.state, "blocked");
        assert.equal((await second.projects.getTask(opened.taskB))?.state, "blocked");
        assert.equal((await storage.getTimer(`wt:${opened.b}`))?.state, "pending");

        // The old service object is fenced out by the new epoch: it can neither answer nor open.
        await assert.rejects(services1.waits.answerWait({ commandId: "stale-answer", actor: "rob", waitId: opened.a, expectedRevision: 1, resolverId: "owner", answer: "stale" }), (e: unknown) => e instanceof DomainError && e.code === "stale_epoch");
        assert.equal((await services2.waits.getWait(opened.a))?.state, "open", "a service of an older epoch changed nothing");

        // Passes before the deadline change nothing.
        const early = await services2.reconciler.runPass();
        assert.deepEqual([early.waitsTimedOut, early.waitsOrphaned, early.unexplainedBlocks, early.blockersOpened], [0, 0, 0, 0]);
        assert.equal((await services2.waits.getWait(opened.b))?.state, "open");

        // The deadline passes while a third service instance is the one running: the wait times out exactly once, however many passes follow.
        clock.advance(2 * 60_000);
        const third = await startProcess(world, "service-3");
        const services3 = waitServices(third, world);
        await settleWaits(services3);
        const timed = await services3.waits.getWait(opened.b);
        assert.deepEqual([timed?.state, timed?.outcome], ["timed_out", "timed_out_resumed"]);
        assert.equal((await third.projects.getTask(opened.taskB))?.state, "ready");
        for (let i = 0; i < 3; i++) assert.equal((await services3.reconciler.runPass()).waitsTimedOut, 0);
        assert.equal((await waitAuditCounts(storage)), "wait.open=2 wait.answer=0 wait.deadline=1 wait.cancel=0");

        // The indefinite wait is still the owner's: it is answered once and only once.
        await services3.waits.answerWait({ commandId: "wait-answer-A", actor: "rob", waitId: opened.a, expectedRevision: 1, resolverId: "owner", answer: "yes, delete them" });
        assert.equal((await third.projects.getTask(opened.taskA))?.state, "ready");
        await assert.rejects(services3.waits.answerWait({ commandId: "wait-answer-A2", actor: "rob", waitId: opened.a, expectedRevision: 2, resolverId: "owner", answer: "again" }), (e: unknown) => e instanceof DomainError && e.code === "wait_closed");
        assert.deepEqual(await checkWaits(third, world), []);
      } finally { await storage.close(); }
    });
  });

  test(`${engine.name}: the real SIGKILL right after both waits were acknowledged: both are in the database before any command runs, and the restarted service finishes the scenario with the clean run's state`, async () => {
    const clean: Clean = await withEngine(engine, async (spec, cleanDir) => { const s = await openStore(spec); try { return await cleanWaitRun(s, cleanDir); } finally { await s.close(); } });
    const lastOpen = clean.operations.filter((o) => o.type === "wait.open").pop()!;
    // One boundary past the acknowledgment of the second wait: the process dies with both waits acknowledged and nothing else done.
    for (const crashAt of [lastOpen.before, lastOpen.after, lastOpen.after + 1]) {
      await withEngine(engine, async (spec, dir) => {
        const child = await runChild(spec, dir, crashAt, "wait");
        assert.equal(child.killed && !child.out.includes("finished"), true, `the child was not killed at ${describe(clean, crashAt)}: ${child.err.slice(0, 300)}`);
        const storage = await openStore(spec);
        try {
          assert.deepEqual(await acknowledgedSurvive(storage, clean, crashAt), []);
          if (crashAt > lastOpen.after) {
            // Acknowledged: both waits exist and both tasks are blocked, read without running a command.
            const waits = await storage.listAggregates("wait", { limit: 10 });
            assert.equal(waits.length, 2);
            assert.ok(waits.every((w) => (w.body as { state: string }).state === "open"));
            const tasks = await storage.listAggregates("task", { limit: 10 });
            assert.deepEqual(tasks.map((t) => (t.body as { state: string }).state), ["blocked", "blocked"]);
            assert.ok((await storage.listAggregates("wait-slot", { limit: 10 })).length === 2);
          }
          const clock = new Clock();
          clock.advance(10 * 60_000);
          const world: SliceWorld = { storage, directory: dir, chaos: new Chaos(), clock: clock.now };
          const slice = await startProcess(world, "restarted");
          await waitScenario(slice, world, clock);
          assert.deepEqual(await checkWaits(slice, world), []);
          assert.equal(await waitSignature(world), clean.signature);
        } finally { await storage.close(); }
      });
    }
  });

  test(`${engine.name}: the controller is killed at the wait boundaries and every fifth boundary of the wait scenario (every boundary when exhaustive) (open, deadline passing, settlement, answer); the waits end as in the clean run, each recorded once`, async () => {
    const clean: Clean = await withEngine(engine, async (spec, cleanDir) => { const s = await openStore(spec); try { return await cleanWaitRun(s, cleanDir); } finally { await s.close(); } });
    const failures: string[] = [];
    for (const crashAt of pickIndexes(clean.labels.length, clean.operations.filter((o) => o.type.startsWith("wait.")).flatMap((o) => [o.before, o.after]), 5)) {
      await withEngine(engine, async (spec, dir) => {
        const storage = await openStore(spec);
        const clock = new Clock();
        const chaos = new Chaos(crashAt);
        const world: SliceWorld = { storage, directory: dir, chaos, clock: clock.now };
        const label = describe(clean, crashAt);
        try {
          try { await waitScenario(await startProcess(world, "child"), world, clock); } catch (error) {
            if (!chaos.crashed) throw error;
            if (!isCrash(error)) throw error;
          }
          if (!chaos.crashed) { failures.push(`${label}: the crash point was never reached`); return; }
          failures.push(...(await acknowledgedSurvive(storage, clean, crashAt)).map((p) => `${label}: ${p}`));
          chaos.revive();
          clock.advance(10 * 60_000);
          const slice = await startProcess(world, "restarted");
          await waitScenario(slice, world, clock);
          failures.push(...(await checkWaits(slice, world)).map((p) => `${label}: ${p}`));
          if ((await waitSignature(world)) !== clean.signature) failures.push(`${label}: the final state differs from the clean run`);
        } finally { await storage.close(); }
      });
    }
    assert.deepEqual(failures, []);
    console.log(`# g04 waits[${engine.name}]: sampled-or-all boundaries of ${clean.labels.length} of the wait scenario crashed, restarted and verified`);
  });
}
