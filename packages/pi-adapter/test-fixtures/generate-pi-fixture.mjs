// Generates a storage fixture with the Pi Durable version installed next to this script: one conversation with a tool
// call (an "extension") and a compaction. Usage: node gen.mjs <outDir> <toolResultField>
import { BACKGROUND_CONTEXT as ctx } from "@earendil-works/chord/context";
import { createModels, fauxProvider, fauxAssistantMessage, fauxToolCall, Type } from "@earendil-works/pi-ai";
import { Harness, createRegistry, defineExtension, defineTool } from "@earendil-works/pi-durable";
import { openNodeJsonlStorage } from "@earendil-works/pi-durable/storage/jsonl/node";
const [out, field] = process.argv.slice(2);
const echo = defineTool({ name: "echo", description: "Returns a sentinel", parameters: Type.Object({}),
  execute: async () => ({ [field]: [{ type: "text", text: "FIXTURE-SENTINEL" }] }) });
const registry = createRegistry(); registry.install(defineExtension({ name: "fixture-ext", tools: [echo] }));
const models = createModels(); const faux = fauxProvider({ provider: "offline", models: [{ id: "scripted" }] }); models.setProvider(faux.provider);
faux.setResponses([
  fauxAssistantMessage(fauxToolCall("echo", {}, { id: "call-1" }), { stopReason: "toolUse" }),
  fauxAssistantMessage("first answer"), fauxAssistantMessage("second answer"), fauxAssistantMessage("SUMMARY-TEXT"),
]);
const h = await Harness.open(await openNodeJsonlStorage(out, ctx), { models, registry, settings: { compaction: { keepRecentTokens: 1 } } }, ctx);
const root = await h.root(ctx, { agent: { model: { provider: "offline", modelId: "scripted" } } });
for (const [id, content] of [["req-1", "use the tool please"], ["req-2", "a second request"]]) {
  const s = await root.submit({ type: "input", content, requestId: id }, ctx); await s.wait(ctx);
}
const t = await root.compact(undefined, ctx); await h.waitForTask(t, ctx);
await h.close(ctx);
console.log("generated", out);
