import assert from "node:assert/strict";
import { after, test } from "node:test";
import { backends, stopServer } from "../domain/testing/backends.js";
import { buildWorld, workGrants } from "./testing/world.js";
import type { WorkerTurnResult } from "./ports.js";

after(stopServer);

// Card W02: how a turn ended is recorded on the attempt, as the worker said, or `unknown` when it said nothing (an older or remote worker) or something this controller does not know. Recorded only: the attempt's outcome is what
// card W03 acts on it: only a normal end succeeds; any other completed turn stops early and its attempt waits to go on (stopped-early.test.ts covers what follows).
for (const backend of backends) {
  test(`${backend.name}: each turn's end kind is recorded on the attempt, unknown when the worker did not say, and only a normal one succeeds`, async () => {
    const store = await backend.open();
    try {
      const w = await buildWorld(store.storage);
      const ann = await w.agent("ann", workGrants(w.project, []));
      const run = async (title: string, result: WorkerTurnResult) => {
        w.worker.script = async () => result;
        const { attemptId } = await w.task(title, ann);
        await w.heartbeatHost();
        await w.dispatcher.tick();
        await w.dispatcher.idle();
        return (await w.dispatcher.get(w.owner, attemptId!))!;
      };
      const kinds = ["length", "empty-visible-text", "no-work-end", "announced-step-without-tool-call", "normal"] as const;
      for (const endKind of kinds) {
        const d = await run(`turn ${endKind}`, { status: "completed", text: "x", endKind, visibleChars: 1 });
        if (endKind === "normal") { assert.equal(d.state, "finished"); assert.equal(d.outcome?.status, "succeeded"); }
        else {
          assert.equal(d.state, "waiting", `${endKind}: a turn that did not end normally stopped early (W03)`); assert.equal(d.outcome, undefined);
          // Stopped here, so its next run does not take the place of the next task's (this test is about the record, stopped-early.test.ts about what follows).
          await w.dispatcher.stop(w.owner, d.attemptId, { reason: "looked at" });
        }
        assert.deepEqual({ endKind: d.turnEnd?.endKind, visibleChars: d.turnEnd?.visibleChars }, { endKind, visibleChars: 1 });
        assert.equal(typeof d.turnEnd?.at, "string");
      }
      w.worker.endsNormally = false;
      const older = await run("older worker", { status: "completed", text: "all done" });
      assert.equal(older.turnEnd?.endKind, "unknown", "a result without an end kind is unknown, never normal");
      assert.equal(older.turnEnd?.visibleChars, undefined);
      assert.equal(older.state, "waiting", "an unknown end is not taken for a normal one (W03)");
      await w.dispatcher.stop(w.owner, older.attemptId, { reason: "looked at" });
      const odd = await run("odd worker", { status: "completed", text: "x", endKind: "finished-nicely" as never, visibleChars: -3 });
      assert.equal(odd.turnEnd?.endKind, "unknown", "a kind this controller does not know is unknown");
      assert.equal(odd.turnEnd?.visibleChars, undefined, "a length that is not a whole number is not recorded");
      await w.dispatcher.stop(w.owner, odd.attemptId, { reason: "looked at" });
      const failed = await run("failed turn", { status: "failed", error: "the model did not answer" });
      assert.equal(failed.outcome?.status, "failed");
      assert.equal(failed.turnEnd?.endKind, "unknown");
    } finally { await store.close(); }
  });
}

// W02 review: the agent's own ending (`work.end`) is completed by the controller's sweep, which can end the attempt while the turn still runs; the turn is then stopped before it can say how it ended. The attempt ended as the agent meant
// it to, so it is recorded `normal`, not left without an ending.
for (const backend of backends) {
  test(`${backend.name}: an attempt the agent's own ending finished while its turn still ran is recorded as ended normally`, async () => {
    const store = await backend.open();
    try {
      const w = await buildWorld(store.storage);
      const ann = await w.agent("ann", workGrants(w.project, []));
      let started!: () => void;
      const running = new Promise<void>((ok) => { started = ok; });
      w.worker.script = async () => { started(); await new Promise(() => undefined); return { status: "completed" }; };
      const { attemptId } = await w.task("ended by the agent", ann);
      await w.heartbeatHost();
      await w.dispatcher.tick();
      await running;
      assert.equal(await w.dispatcher.finishWith(w.owner, attemptId!, { result: "done", note: "parser fixed" }), true);
      await w.dispatcher.idle();
      const d = (await w.dispatcher.get(w.owner, attemptId!))!;
      assert.equal(d.state, "finished");
      assert.equal(d.outcome?.status, "succeeded");
      assert.equal(d.turnEnd?.endKind, "normal");
      assert.equal(d.turnEnd?.visibleChars, undefined, "the turn said nothing, so no length is recorded");
    } finally { await store.close(); }
  });
}
