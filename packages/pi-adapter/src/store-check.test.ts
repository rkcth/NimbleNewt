import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { MemoryStorage } from "@earendil-works/pi-durable";
import { requestId } from "@nimblenewt/contracts";
import { PiAdapter, missingCheckpoints } from "./index.js";
import { OFFLINE_MODEL_REF, createOfflineModels } from "./testing/offline.js";

const cleanup: (() => Promise<void> | void)[] = [];
afterEach(async () => { for (const fn of cleanup.splice(0).reverse()) await fn(); });

async function world() {
  const offline = createOfflineModels();
  offline.faux.setResponses([fauxAssistantMessage("answer one"), fauxAssistantMessage("answer two")]);
  const adapter = await PiAdapter.open({ storage: new MemoryStorage(), models: offline.models, model: OFFLINE_MODEL_REF });
  cleanup.push(() => adapter.close());
  const conversation = adapter.root();
  await (await conversation.submit({ kind: "input", requestId: requestId("t1"), content: "first request" })).result();
  const good = await conversation.checkpoint();
  await (await conversation.submit({ kind: "input", requestId: requestId("t2"), content: "second request" })).result();
  return { adapter, good };
}
const ref = (id: string, checkpoint: unknown) => ({ id, attemptId: `att-${id}`, checkpoint: typeof checkpoint === "string" ? checkpoint : JSON.stringify(checkpoint) });

test("a checkpoint the store still holds is not missing; every way a checkpoint can fail to hold is named by its recovery point (card F04l)", async () => {
  const { adapter, good } = await world();
  const stored = { conversationId: good.conversationId, at: good.at, digest: good.digest, runtime: good.runtime, format: good.format };
  const points = [
    ref("ok", good),
    ref("ok-as-the-controller-stores-it", stored),
    ref("stored-wrong-digest", { ...stored, digest: `v1:sha256:${"1".repeat(64)}` }),
    ref("stored-other-runtime", { ...stored, runtime: { name: "other-runtime", version: "1" } }),
    ref("no-checkpoint-recorded", "null"),
    ref("other-conversation", { ...good, conversationId: 9999 }),
    ref("no-such-entry", { ...good, at: good.at + 1000 }),
    ref("history-changed", { ...good, digest: `v1:sha256:${"0".repeat(64)}` }),
    ref("not-json", "{not json"),
    ref("not-an-object", "[1,2]"),
    ref("old-runtime", { ...good, runtime: { name: "pi-durable", version: "0.0.1" } }),
    ref("other-history-format", { ...good, historyFormat: "other" }),
  ];
  assert.deepEqual(await missingCheckpoints(adapter, points), ["stored-wrong-digest", "stored-other-runtime", "no-checkpoint-recorded", "other-conversation", "no-such-entry", "history-changed", "not-json", "not-an-object", "old-runtime", "other-history-format"]);
});

test("nothing to check answers nothing missing, and a store that cannot be read is an error, never 'nothing missing' (card F04l)", async () => {
  const { adapter, good } = await world();
  assert.deepEqual(await missingCheckpoints(adapter, []), []);
  const broken = { verifyCheckpoint: async () => { throw new Error("the store cannot be read"); } };
  await assert.rejects(missingCheckpoints(broken, [ref("ok", good)]), /cannot be read/);
});
