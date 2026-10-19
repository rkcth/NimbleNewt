// Child process for restore.test.ts: starts a request whose tool kills this process mid-effect.
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { openNodeJsonlStorage } from "@earendil-works/pi-durable/storage/jsonl/node";
import { requestId } from "@nimblenewt/contracts";
import { PiAdapter } from "../adapter.js";
import { effectTool } from "./crash-fixture.js";
import { OFFLINE_MODEL_REF, createOfflineModels } from "./offline.js";

const [directory, logFile, replay] = process.argv.slice(2);
if (directory === undefined || logFile === undefined) throw new Error("usage: crash-child <storage-dir> <log-file> [safe]");

const offline = createOfflineModels();
// Only the tool call is scripted: the process is killed during the tool, so no later model step runs here.
offline.faux.setResponses([fauxAssistantMessage(fauxToolCall("effect", {}, { id: "effect-call" }), { stopReason: "toolUse" })]);
const adapter = await PiAdapter.open({
  storage: await openNodeJsonlStorage(directory, BACKGROUND_CONTEXT),
  models: offline.models,
  model: OFFLINE_MODEL_REF,
  tools: [effectTool(logFile, { killFirstAttempt: true, ...(replay === "safe" ? { replay: "safe" as const } : {}) })],
});
const handle = await adapter.root().submit({ kind: "input", requestId: requestId("kill-1"), content: "do the effect" });
await handle.result(); // never returns: the tool kills the process
