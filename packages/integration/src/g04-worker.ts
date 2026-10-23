/**
 * Worker host for card G04: the real Pi adapter (durable JSONL storage in <directory>) in a process of its own, driven by line-delimited JSON on
 * stdin/stdout, so a test can kill the worker with SIGKILL while the controller lives. Usage: node g04-worker.js <directory> <mode>.
 * Modes: `normal`; `die-in-model` (SIGKILL when the scripted provider is asked for its answer, i.e. with the request in flight);
 * `die-after-answer` (SIGKILL after the adapter settled the request and before the controller has been told). This file holds glue only:
 * everything it does is the production adapter and the integration package's `piConversation`.
 */
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createModels, fauxAssistantMessage, fauxProvider } from "@earendil-works/pi-ai";
import { openNodeJsonlStorage } from "@earendil-works/pi-durable/storage/jsonl/node";
import { PiAdapter } from "@nimblenewt/pi-adapter";
import { ANSWER } from "@nimblenewt/controller/testing";
import { piConversation } from "./conversation.js";

const [directory, mode] = process.argv.slice(2) as [string, string];
const kill = (): never => { process.kill(process.pid, "SIGKILL"); Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0); throw new Error("unreachable"); };

const models = createModels();
const faux = fauxProvider({ provider: "offline", models: [{ id: "scripted" }] });
models.setProvider(faux.provider);
faux.setResponses([() => { if (mode === "die-in-model") kill(); return fauxAssistantMessage(ANSWER); }]);
const adapter = await PiAdapter.open({ storage: await openNodeJsonlStorage(directory, BACKGROUND_CONTEXT), models, model: { provider: "offline", modelId: "scripted" }, tools: [] });
const conversation = piConversation(adapter);
const handles = new Map<string, { result(): Promise<unknown> }>();
let recovered = 0;

const ops: Record<string, (args: Record<string, unknown>) => Promise<unknown>> = {
  submit: async ({ requestId, content }) => { handles.set(requestId as string, await conversation.submit({ requestId: requestId as string, content: content as string })); return null; },
  result: async ({ requestId }) => {
    const settled = await handles.get(requestId as string)!.result();
    if (mode === "die-after-answer") kill();
    return settled;
  },
  lookup: async ({ requestId }) => (await conversation.lookup!(requestId as string)) ?? null,
  interrupted: async () => conversation.interrupted!(),
  recover: async ({ reason }) => { recovered += 1; await conversation.recover!(reason as string); return null; },
  checkpoint: async () => conversation.checkpoint!(),
  // What the test needs to count: how often the model was asked, how often it answered into the transcript, and the task as a user message.
  stats: async () => {
    const transcript = await adapter.root().transcript();
    return { modelCalls: faux.state.callCount, answers: transcript.filter((e) => e.text === ANSWER).length, inputs: transcript.filter((e) => e.role === "user" && e.text.includes("Order seeds")).length, recovered };
  },
  verify: async ({ checkpoint }) => (await adapter.root().verifyCheckpoint(checkpoint as never)).valid,
  close: async () => { await adapter.close(); return null; },
};

let buffer = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk: string) => {
  buffer += chunk;
  for (let at = buffer.indexOf("\n"); at >= 0; at = buffer.indexOf("\n")) {
    const line = buffer.slice(0, at);
    buffer = buffer.slice(at + 1);
    const { id, op, args } = JSON.parse(line) as { id: number; op: string; args: Record<string, unknown> };
    ops[op]!(args ?? {}).then(
      (value) => process.stdout.write(`${JSON.stringify({ id, value })}\n`),
      (error: unknown) => process.stdout.write(`${JSON.stringify({ id, error: error instanceof Error ? error.message : String(error) })}\n`),
    );
  }
});
process.stdin.on("end", () => { void adapter.close().finally(() => process.exit(0)); });
process.stdout.write(`${JSON.stringify({ id: 0, value: "ready" })}\n`);
