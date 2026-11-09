import assert from "node:assert/strict";
import { after, test } from "node:test";
import { backends, stopServer } from "../domain/testing/backends.js";
import { buildWorld, workGrants } from "./testing/world.js";
import type { WorkerTurnResult } from "./ports.js";

after(stopServer);

// Card W02: how a turn ended is recorded on the attempt, as the worker said, or `unknown` when it said nothing (an older or remote worker) or something this controller does not know. Recorded only: the attempt's outcome is what
// it was before (W03 will act on it), so a completed turn still ends the attempt succeeded whatever its end kind.
for (const backend of backends) {
  test(`${backend.name}: each turn's end kind is recorded on the attempt, unknown when the worker did not say, and the outcome does not change with it`, async () => {
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
        assert.equal(d.state, "finished", endKind);
        assert.equal(d.outcome?.status, "succeeded", `${endKind}: a completed turn still succeeds (W03 decides otherwise later)`);
        assert.deepEqual({ endKind: d.turnEnd?.endKind, visibleChars: d.turnEnd?.visibleChars }, { endKind, visibleChars: 1 });
        assert.equal(typeof d.turnEnd?.at, "string");
      }
      const older = await run("older worker", { status: "completed", text: "all done" });
      assert.equal(older.turnEnd?.endKind, "unknown", "a result without an end kind is unknown, never normal");
      assert.equal(older.turnEnd?.visibleChars, undefined);
      assert.equal(older.outcome?.status, "succeeded");
      const odd = await run("odd worker", { status: "completed", text: "x", endKind: "finished-nicely" as never, visibleChars: -3 });
      assert.equal(odd.turnEnd?.endKind, "unknown", "a kind this controller does not know is unknown");
      assert.equal(odd.turnEnd?.visibleChars, undefined, "a length that is not a whole number is not recorded");
      const failed = await run("failed turn", { status: "failed", error: "the model did not answer" });
      assert.equal(failed.outcome?.status, "failed");
      assert.equal(failed.turnEnd?.endKind, "unknown");
    } finally { await store.close(); }
  });
}
