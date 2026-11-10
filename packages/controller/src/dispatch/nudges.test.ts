import assert from "node:assert/strict";
import { after, test } from "node:test";
import { backends, stopServer } from "../domain/testing/backends.js";
import { buildWorld, workGrants, type DispatchWorld } from "./testing/world.js";
import type { WorkerTurnResult } from "./ports.js";

after(stopServer);

// Card W04: the worker continues a turn that yields early (at most three nudges) and says how many it gave with the turn's result. The attempt records each turn's nudges with how the turn ended, on each stopped-early run, and the
// attempt's total, so the owner's view (W08) can show them; the W03 blocker says how many nudges the last turn had. The nudged model calls are charged through the turn's usage like any other: the count changes no accounting.

async function runOnce(w: DispatchWorld): Promise<void> {
  await w.heartbeatHost();
  await w.dispatcher.tick();
  await w.dispatcher.idle();
}

for (const backend of backends) {
  test(`${backend.name}: each turn's nudges are recorded with its ending and summed on the attempt across W03's go-ons; the blocker says how many the last turn had`, async () => {
    const store = await backend.open();
    try {
      const w = await buildWorld(store.storage);
      const ann = await w.agent("ann", workGrants(w.project, []));
      let n = 0;
      // Three runs of a turn that the worker nudged three times each and that still ended with nothing visible.
      w.worker.script = async (): Promise<WorkerTurnResult> => ({ status: "completed", text: "", endKind: "empty-visible-text", visibleChars: 0, nudges: 3, checkpoint: { turn: ++n } });
      const { taskId, attemptId } = await w.task("never acts", ann);
      await runOnce(w);
      let d = (await w.dispatcher.get(w.owner, attemptId!))!;
      assert.equal(d.state, "waiting");
      assert.equal(d.turnEnd?.nudges, 3);
      assert.equal(d.nudgesUsed, 3);
      assert.deepEqual(d.stoppedEarly?.map((r) => r.nudges), [3]);
      await runOnce(w);
      await runOnce(w);
      d = (await w.dispatcher.get(w.owner, attemptId!))!;
      assert.equal(d.outcome?.status, "stopped-early");
      assert.equal(d.nudgesUsed, 9, "three turns of three nudges: the attempt's total");
      assert.deepEqual(d.stoppedEarly?.map((r) => [r.nudges, r.readmitted]), [[3, true], [3, true], [3, false]]);
      const blocker = await w.blockers.openFor("agent_stopped_early", { kind: "task", id: taskId });
      assert.match(blocker?.summary ?? "", /the last turn ended: empty-visible-text, 0 visible characters, after 3 nudge\(s\) to go on/);
    } finally { await store.close(); }
  });
}

for (const backend of backends) {
  test(`${backend.name}: a turn that was nudged and then ended normally records its nudges; none said is none recorded; a figure that is not a count is left out; a failed turn keeps its nudges`, async () => {
    const store = await backend.open();
    try {
      const w = await buildWorld(store.storage);
      const ann = await w.agent("ann", workGrants(w.project, []));
      const run = async (title: string, result: WorkerTurnResult) => {
        w.worker.script = async () => result;
        const { attemptId } = await w.task(title, ann);
        await runOnce(w);
        return (await w.dispatcher.get(w.owner, attemptId!))!;
      };
      const finished = await run("nudged twice then done", { status: "completed", text: "Ended.", endKind: "normal", visibleChars: 6, nudges: 2 });
      assert.equal(finished.outcome?.status, "succeeded");
      assert.equal(finished.turnEnd?.nudges, 2);
      assert.equal(finished.nudgesUsed, 2);
      const none = await run("not nudged", { status: "completed", text: "Ended.", endKind: "normal", visibleChars: 6, nudges: 0 });
      assert.equal(none.turnEnd?.nudges, 0);
      assert.equal(none.nudgesUsed, undefined, "no total while there were none");
      const older = await run("older worker", { status: "completed", text: "Ended.", endKind: "normal", visibleChars: 6 });
      assert.equal(older.turnEnd?.nudges, undefined, "a worker from before W04 says nothing, and nothing is claimed");
      for (const bad of [-1, 1.5, 101]) {
        const odd = await run(`odd ${bad}`, { status: "completed", text: "Ended.", endKind: "normal", visibleChars: 6, nudges: bad });
        assert.equal(odd.turnEnd?.nudges, undefined, String(bad));
        assert.equal(odd.nudgesUsed, undefined, String(bad));
      }
      const failed = await run("nudged then failed", { status: "failed", error: "the model did not answer", nudges: 1 });
      assert.equal(failed.outcome?.status, "failed");
      assert.equal(failed.turnEnd?.nudges, 1);
      assert.equal(failed.nudgesUsed, 1);
    } finally { await store.close(); }
  });
}
