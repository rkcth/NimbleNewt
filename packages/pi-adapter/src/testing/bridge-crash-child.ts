// Child process for the G04 follow-up test in restore.test.ts: the real bridge tools in a real Pi conversation, killed by SIGKILL while the model's second
// desk.write (sent under a provider call ID used once already, as a local server that counts from zero in every reply does) is with the controller.
import { appendFileSync, readFileSync, existsSync } from "node:fs";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { openNodeJsonlStorage } from "@earendil-works/pi-durable/storage/jsonl/node";
import { requestId } from "@nimblenewt/contracts";
import { PiAdapter } from "../adapter.js";
import { createBridge, type BridgeReply, type BridgeRequest } from "../bridge.js";
import { BRIDGE_CRASH_REPLIES } from "./bridge-crash-fixture.js";
import { OFFLINE_MODEL_REF, createOfflineModels } from "./offline.js";

const [directory, logFile] = process.argv.slice(2);
if (directory === undefined || logFile === undefined) throw new Error("usage: bridge-crash-child <storage-dir> <log-file>");

const writes = (): number => (existsSync(logFile) ? readFileSync(logFile, "utf8").split("\n").filter((l) => l.includes("\"desk.write\"")).length : 0);
const bridge = createBridge({
  send: async (request: BridgeRequest): Promise<BridgeReply> => {
    appendFileSync(logFile, `${JSON.stringify({ op: request.op, callId: request.callId })}\n`);
    // The controller has the second write when the process dies: its answer never reaches the conversation.
    if (request.op === "desk.write" && writes() === 2) (process.kill(process.pid, "SIGKILL"), Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0));
    return { ok: true, result: { recordId: `dsk-${writes()}` } };
  },
});
const offline = createOfflineModels();
offline.faux.setResponses(BRIDGE_CRASH_REPLIES.slice(0, 2));
const adapter = await PiAdapter.open({ storage: await openNodeJsonlStorage(directory, BACKGROUND_CONTEXT), models: offline.models, model: OFFLINE_MODEL_REF, tools: bridge.tools });
const handle = await adapter.root().submit({ kind: "input", requestId: requestId("bridge-kill-1"), content: "write two notes" });
await handle.result(); // never returns: the process dies during the second write
