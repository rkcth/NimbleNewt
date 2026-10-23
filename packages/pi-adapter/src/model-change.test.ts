import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { requestId } from "@nimblenewt/contracts";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createModels, fauxAssistantMessage, fauxProvider } from "@earendil-works/pi-ai";
import { openNodeJsonlStorage } from "@earendil-works/pi-durable/storage/jsonl/node";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PiAdapter } from "./index.js";

const dirs: string[] = [];
const adapters: PiAdapter[] = [];
afterEach(async () => { for (const a of adapters.splice(0)) await a.close(); for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });

function scripted(name: string) {
  const models = createModels();
  const faux = fauxProvider({ provider: name, models: [{ id: "m" }] });
  models.setProvider(faux.provider);
  const seen: string[] = [];
  const answer = (text: string) => faux.setResponses([(context) => { seen.push(JSON.stringify(context.messages)); return fauxAssistantMessage(text); }]);
  return { models, ref: { provider: name, modelId: "m" }, seen, answer };
}
const input = (id: string, content: string) => ({ kind: "input", requestId: requestId(id), content }) as const;

test("a conversation moves to another provider after a restart: same history, same context, no summary, and the old provider is gone", async () => {
  const dir = mkdtempSync(join(tmpdir(), "nn-model-"));
  dirs.push(dir);
  const one = scripted("first");
  const a1 = await PiAdapter.open({ storage: await openNodeJsonlStorage(dir, BACKGROUND_CONTEXT), models: one.models, model: one.ref });
  one.answer("answer one");
  await (await a1.root().submit(input("r1", "question one"))).result();
  const before = await a1.root().transcript();
  await a1.close();

  const two = scripted("second");
  const a2 = await PiAdapter.open({ storage: await openNodeJsonlStorage(dir, BACKGROUND_CONTEXT), models: two.models, model: two.ref });
  adapters.push(a2);
  two.answer("never asked");
  // Before the move the conversation still names the old provider, which this process does not have: the request is not answered, and nothing is guessed.
  const refused = await (await a2.root().submit(input("r2", "question two"))).result();
  assert.deepEqual([refused.status, refused.status === "unanswered" && refused.reason], ["unanswered", "no_model"]);
  assert.equal(two.seen.length, 0);

  const root = a2.root();
  await root.useModel(two.ref);
  two.answer("answer two");
  const moved = await (await root.submit(input("r3", "question three"))).result();
  assert.equal(moved.status, "completed");
  const seen = two.seen[0]!;
  assert.ok(seen.indexOf("question one") >= 0 && seen.indexOf("question one") < seen.indexOf("answer one") && seen.indexOf("answer one") < seen.indexOf("question three"), "the earlier context reached the new provider, in order");
  assert.ok(!(await root.transcript()).some((e) => e.kind === "pi.compaction"));
  assert.deepEqual((await root.transcript()).slice(0, before.length), before);
});
