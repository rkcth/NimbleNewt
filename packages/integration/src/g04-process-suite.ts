import assert from "node:assert/strict";
import { join } from "node:path";
import { after, test } from "node:test";
import type { ConversationSubmitter } from "@nimblenewt/controller";
import { keyPoints, STRIDE } from "./g04-kill.js";
import { HEAVY_SKIP, isCrash, EXHAUSTIVE, Chaos, Clock, Crash, WorkerHost, acknowledgedSurvive, cleanRun, describe, engines, openStore, pickIndexes, runPath, startProcess, stopServer, verifyFinished, withEngine, type Clean, type SliceWorld } from "./g04-fixture.js";

/**
 * Card G04, the two halves of the system dying separately. The Pi adapter runs in a worker process of its own (the controller's bridge talks to it over a pipe);
 * the controller services run in the test process over the real database.
 */
export function defineProcessTests(engineName: string): void {
  const engine = engines.find((e) => e.name === engineName)!;
  after(stopServer);

  for (const mode of ["die-in-model", "die-after-answer"] as const) {
    test(`${engine.name}: the worker is killed with SIGKILL ${mode === "die-in-model" ? "while the model request is in flight" : "after the adapter settled the request and before the controller heard of it"}; the controller lives, a new worker finishes the work, and the model's answer is in the transcript once`, { skip: HEAVY_SKIP }, async () => {
      const clean = await withEngine(engine, (spec, dir) => cleanRun(spec, dir));
      await withEngine(engine, async (spec, dir) => {
        const storage = await openStore(spec);
        const pi = join(dir, "pi");
        let worker = await WorkerHost.start(pi, mode);
        // The controller keeps one conversation port for its whole life; which worker is behind it changes.
        const port: ConversationSubmitter = {
          submit: (r) => worker.conversation().submit(r),
          lookup: (id) => worker.conversation().lookup!(id),
          interrupted: () => worker.conversation().interrupted!(),
          recover: (reason) => worker.conversation().recover!(reason),
          checkpoint: () => worker.conversation().checkpoint!(),
        };
        const world: SliceWorld = { storage, directory: dir, chaos: new Chaos(), clock: new Clock().now, conversation: () => port };
        try {
          const slice = await startProcess(world, "controller");
          await assert.rejects(runPath(slice), (error: unknown) => /worker process is gone/.test(String(error instanceof Error ? error.message : error)) || (error as { cause?: unknown }).cause !== undefined);
          assert.notEqual(await worker.exited, "exit 0", "the worker was killed, not stopped"); // POSIX reports SIGKILL; Windows a non-zero exit code
          // The acknowledged request is still there: the inbox message is admitted, the attempt is the task's active one, nothing past the model step has happened.
          const message = await slice.inbox.getMessage(slice.ids.messageId);
          assert.equal(message?.state, "admitted");
          assert.equal((await slice.assign.getAssignment(slice.ids.task))?.activeAttemptId, slice.ids.attemptId);
          assert.equal(await slice.recovery.forAttempt(slice.ids.attemptId), undefined);
          assert.equal(await slice.effects.get(slice.ids.effect), undefined, "no effect was intended before the model answered");

          worker = await WorkerHost.start(pi, "normal");
          await runPath(slice); // the same fixed commands, same controller, same epoch
          const problems = await verifyFinished(slice, world, worker.probe(), clean);
          assert.deepEqual(problems, []);
          const stats = await worker.probe().stats();
          if (mode === "die-in-model") assert.deepEqual([stats.modelCalls, stats.recovered], [1, 1], "the new worker asked the model once, after the reviewed recovery step released the interrupted request");
          else assert.equal(stats.modelCalls, 0, "the answer was already durable: the new worker did not ask the model again");
        } finally { await worker.stop(); await storage.close(); }
      });
    });
  }

  test(`${engine.name}: the controller is killed at the key boundaries of the path (every boundary when exhaustive) while the worker process lives on; the model is asked exactly once and nothing acknowledged is lost`, { skip: HEAVY_SKIP }, async () => {
    const clean: Clean = await withEngine(engine, (spec, dir) => cleanRun(spec, dir));
    const failures: string[] = [];
    for (const crashAt of pickIndexes(clean.labels.length, keyPoints(clean), STRIDE)) {
      await withEngine(engine, async (spec, dir) => {
        const storage = await openStore(spec);
        const worker = await WorkerHost.start(join(dir, "pi"), "normal");
        const clock = new Clock();
        const chaos = new Chaos(crashAt);
        const world: SliceWorld = { storage, directory: dir, chaos, clock: clock.now, conversation: () => worker.conversation() };
        const label = describe(clean, crashAt);
        try {
          try { await runPath(await startProcess(world, "child")); } catch (error) {
            if (!chaos.crashed) throw error;
            if (!isCrash(error)) throw error;
          }
          if (!chaos.crashed) { failures.push(`${label}: the crash point was never reached`); return; }
          failures.push(...(await acknowledgedSurvive(storage, clean, crashAt)).map((p) => `${label}: ${p}`));
          chaos.revive();
          clock.advance(10 * 60_000);
          const slice = await startProcess(world, "restarted");
          await runPath(slice);
          failures.push(...(await verifyFinished(slice, world, worker.probe(), clean, clean.labels[crashAt])).map((p) => `${label}: ${p}`));
          const stats = await worker.probe().stats();
          if (stats.modelCalls !== 1) failures.push(`${label}: the model was asked ${stats.modelCalls} time(s)`);
        } finally { await worker.stop(); await storage.close(); }
      });
    }
    assert.deepEqual(failures, []);
    console.log(`# g04 controller killed[${engine.name}]: ${EXHAUSTIVE ? "every" : "sampled"} boundary of ${clean.labels.length}, worker process alive throughout, model asked once each time`);
  });
}
