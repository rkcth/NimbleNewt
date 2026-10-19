import assert from "node:assert/strict";
import { afterEach, beforeEach, test } from "node:test";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import { OFFLINE_MODEL, OFFLINE_PROVIDER, createOfflineHarness, type OfflineHarness } from "./testing/offline.js";

let offline: OfflineHarness | undefined;

beforeEach(async () => {
  offline = await createOfflineHarness();
});
afterEach(async () => {
  await offline?.close();
  offline = undefined;
});

test("a submitted input is answered by the scripted model with no network", async () => {
  offline!.respondWith("finished");
  const root = await offline!.harness.root(context, { agent: { model: { provider: OFFLINE_PROVIDER, modelId: OFFLINE_MODEL } } });
  const submission = await root.submit({ type: "input", content: "hello", requestId: "smoke-1" }, context);
  const settled = await submission.wait(context);
  assert.equal(settled.status, "done");
  const view = await root.viewState(context);
  try {
    const kinds = view.value.entries.map((entry) => entry.kind);
    assert.deepEqual(kinds, ["pi.user", "pi.assistant"]);
    assert.match(JSON.stringify(view.value.entries[1]), /"text":"finished"/);
  } finally {
    view.dispose();
  }
});
