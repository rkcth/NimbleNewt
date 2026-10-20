// Child process for hold.test.ts: leaves TWO conversations interrupted. The root conversation is blocked inside toolA; a
// branch calls toolB, which waits until toolA has started and then kills this process.
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { openNodeJsonlStorage } from "@earendil-works/pi-durable/storage/jsonl/node";
import { requestId } from "@nimblenewt/contracts";
import { PiAdapter } from "../adapter.js";
import { twoConversationTools } from "./crash-fixture.js";
import { OFFLINE_MODEL_REF, createOfflineModels } from "./offline.js";

const [directory] = process.argv.slice(2);
if (directory === undefined) throw new Error("usage: crash-child-two <storage-dir>");

const offline = createOfflineModels();
// Replies depend on which task the model is asked about, since the two conversations run concurrently.
offline.faux.setResponses(Array.from({ length: 4 }, () => (context: { messages: readonly unknown[] }) => {
  const text = JSON.stringify(context.messages.at(-1));
  if (text.includes("TASK-A")) return fauxAssistantMessage(fauxToolCall("toolA", {}, { id: "call-a" }), { stopReason: "toolUse" });
  if (text.includes("TASK-B")) return fauxAssistantMessage(fauxToolCall("toolB", {}, { id: "call-b" }), { stopReason: "toolUse" });
  return fauxAssistantMessage("ready");
}));
const adapter = await PiAdapter.open({
  storage: await openNodeJsonlStorage(directory, BACKGROUND_CONTEXT),
  models: offline.models,
  model: OFFLINE_MODEL_REF,
  tools: twoConversationTools(directory, { child: true }),
});
const root = adapter.root();
await (await root.submit({ kind: "input", requestId: requestId("setup"), content: "set things up" })).result();
const branch = await root.branch({ requestId: requestId("side") });
writeFileSync(join(directory, "ids.json"), JSON.stringify({ root: root.id, branch: branch.conversation.id }));
await root.submit({ kind: "input", requestId: requestId("req-a"), content: "TASK-A" });
await branch.conversation.submit({ kind: "input", requestId: requestId("req-b"), content: "TASK-B" });
await root.submit({ kind: "input", requestId: requestId("req-a2"), content: "QUEUED-AFTER-A" }); // queued behind req-a
await new Promise(() => {}); // the process is killed from inside toolB
