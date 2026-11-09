import assert from "node:assert/strict";
import { after, test } from "node:test";
import { backends, stopServer } from "../domain/testing/backends.js";
import { buildWorld, workGrants } from "./testing/world.js";

after(stopServer);

// W02 review: every write to a dispatch record names its command `dpa-up:<attempt>:<revision>:<instance>`. Two writes that read the same revision in one dispatcher shared that ID, so the second was taken for a replay of the first and
// dropped while its caller was told it had been written. Each write now has an ID of its own; two writes made at once are both kept (the second reads the first's revision and is written again).
for (const backend of backends) {
  test(`${backend.name}: writes made at the same moment to one attempt are all kept, none is taken for a replay of another`, async () => {
    const store = await backend.open();
    try {
      const w = await buildWorld(store.storage);
      const ann = await w.agent("ann", workGrants(w.project, []));
      let release!: () => void;
      const held = new Promise<void>((ok) => { release = ok; });
      let started!: () => void;
      const running = new Promise<void>((ok) => { started = ok; });
      w.worker.script = async () => { started(); await held; return { status: "completed", text: "x" }; };
      const { attemptId } = await w.task("racing writes", ann);
      await w.heartbeatHost();
      await w.dispatcher.tick();
      await running;
      const before = (await w.dispatcher.get(w.owner, attemptId!))!.heartbeats;
      await Promise.all([1, 2, 3, 4].map(() => w.dispatcher.heartbeat(attemptId!)));
      assert.equal((await w.dispatcher.get(w.owner, attemptId!))!.heartbeats, before + 4, "each of the four heartbeats is counted");
      release();
      await w.dispatcher.idle();
    } finally { await store.close(); }
  });
}
