import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { Type, fauxAssistantMessage, fauxText, fauxThinking } from "@earendil-works/pi-ai";
import { openNodeJsonlStorage } from "@earendil-works/pi-durable/storage/jsonl/node";
import { requestId, type AuditEvent } from "@nimblenewt/contracts";
import { PiAdapter, storedThinking, thinkingFor, type AdapterTool, type ThinkingDropReport } from "./index.js";
import { addRig, rig, wireBody, type Rig } from "./testing/wire.js";

// Card C06b, owner decision 2026-10-22: the model's thinking is kept with the stored conversation and replayed in order when it is resumed or switched, so the model keeps its own reasoning and the provider accepts the history.

const dirs: string[] = [];
const adapters: PiAdapter[] = [];
afterEach(async () => { for (const a of adapters.splice(0)) await a.close(); for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });
const input = (id: string, content: string) => ({ kind: "input", requestId: requestId(id), content }) as const;
const SIGNED = { ...fauxThinking("the vendor quote looks low, check the currency"), thinkingSignature: "SIGNATURE-ONLY-THE-PROVIDER-NEEDS" };
const ENCRYPTED = { type: "thinking" as const, thinking: "[Reasoning redacted]", thinkingSignature: "ENCRYPTED-PAYLOAD-123", redacted: true };
const tool: AdapterTool = { name: "lookup", description: "look something up", parameters: Type.Object({}), execute: async () => "found" };
const PROVIDER_HISTORY = (body: Record<string, unknown>): { type: string; thinking?: string; signature?: string; data?: string }[] =>
  ((body["messages"] as { role: string; content: unknown }[]).find((m) => m.role === "assistant")!.content as { type: string }[]);

async function open(world: Rig, storage: Awaited<ReturnType<typeof openNodeJsonlStorage>>, extra: Partial<Parameters<typeof PiAdapter.open>[0]> = {}) {
  const adapter = await PiAdapter.open({ storage, models: world.models, model: world.ref, tools: [tool], promptLayout: { preamble: "Be exact." }, ...extra });
  adapters.push(adapter);
  return adapter;
}
const tmp = (): string => { const d = mkdtempSync(join(tmpdir(), "nn-think-")); dirs.push(d); return d; };

test("stored thinking is replayed to the provider unchanged, in order, on the next turn, after a restart and after the harness changed", async () => {
  const dir = tmp();
  const world = rig("anthropic-messages");
  const one = await open(world, await openNodeJsonlStorage(dir, BACKGROUND_CONTEXT));
  world.reply(fauxAssistantMessage([SIGNED, ENCRYPTED, fauxText("The quote is in euros.")]), "second answer");
  await (await one.root().submit(input("r1", "is the quote right?"))).result();
  await (await one.root().submit(input("r2", "and the delivery date?"))).result();
  await one.close();
  // A restart with a different harness: other tools, another layout, other settings.
  const two = await open(world, await openNodeJsonlStorage(dir, BACKGROUND_CONTEXT), { tools: [], promptLayout: { preamble: "Be exact and kind." }, settings: { compaction: { enabled: false } } });
  world.reply("third answer");
  await (await two.root().submit(input("r3", "thanks"))).result();
  for (const [i, seen] of world.seen.slice(1).entries()) {
    const stored = (seen.context.messages as { role: string; content: unknown }[]).find((m) => m.role === "assistant")!.content as unknown[];
    assert.deepEqual(stored.slice(0, 2), [SIGNED, ENCRYPTED], `turn ${i + 2}: the model-level history carries both blocks exactly as the provider returned them, before the text`);
    const history = PROVIDER_HISTORY(await wireBody(seen));
    assert.deepEqual(history.map((b) => b.type), ["thinking", "redacted_thinking", "text"], `turn ${i + 2}: provider request`);
    assert.equal(history[0]!.thinking, "the vendor quote looks low, check the currency");
    assert.equal(history[0]!.signature, "SIGNATURE-ONLY-THE-PROVIDER-NEEDS");
    assert.equal(history[1]!.data, "ENCRYPTED-PAYLOAD-123");
  }
});

test("the owner's view of stored thinking is readable text without the provider's signature; the transcript and every other view carry words only", async () => {
  const world = rig("anthropic-messages");
  const adapter = await open(world, await openNodeJsonlStorage(tmp(), BACKGROUND_CONTEXT));
  world.reply(fauxAssistantMessage([SIGNED, ENCRYPTED, fauxText("The quote is in euros.")]));
  await (await adapter.root().submit(input("r1", "is the quote right?"))).result();
  const thinking = await adapter.root().thinking();
  assert.deepEqual(thinking.map((t) => [t.text, t.opaque, t.provider, t.model]), [["the vendor quote looks low, check the currency", false, "anthropic", "claude-x"], ["", true, "anthropic", "claude-x"]]);
  assert.ok(thinking.every((t) => t.conversationId === adapter.root().id && t.entryId > 0));
  assert.ok(!JSON.stringify(thinking).includes("SIGNATURE") && !JSON.stringify(thinking).includes("ENCRYPTED"), "the proof the provider needs is not in the view");
  const shown = JSON.stringify(await adapter.root().transcript());
  assert.ok(shown.includes("The quote is in euros.") && !shown.includes("vendor quote") && !shown.includes("SIGNATURE"), "the transcript has the words said, not the thinking");
  // A branch has the same thinking as part of its inherited history, and a separate task has none.
  const branch = await adapter.root().branch({ requestId: requestId("inq") });
  assert.equal((await (branch.conversation as unknown as { thinking(): Promise<unknown[]> }).thinking()).length, 2);
  const task = await adapter.createTask({ requestId: requestId("t1") });
  assert.deepEqual(await (task.conversation as unknown as { thinking(): Promise<unknown[]> }).thinking(), []);
});

test("a model change leaves out only the thinking the new model cannot accept, records that, keeps the thinking, and the first model gets it back", async () => {
  const first = rig("anthropic-messages", "anthropic", "claude-x");
  const second = addRig(first, "openai-responses", "openai", "gpt-y");
  const audit: AuditEvent[] = [];
  const drops: ThinkingDropReport[] = [];
  const adapter = await open(first, await openNodeJsonlStorage(tmp(), BACKGROUND_CONTEXT), { audit: (e) => { audit.push(e); }, cache: { onThinkingDropped: (r) => drops.push(r) } });
  first.reply(fauxAssistantMessage([SIGNED, fauxText("answer one")]));
  await (await adapter.root().submit(input("r1", "first question"))).result();
  const before = await adapter.root().thinking();
  // The conversation moves to a provider that did not produce the thinking.
  await adapter.root().useModel(second.ref);
  second.reply(fauxAssistantMessage([{ ...fauxThinking("gpt reasoning"), thinkingSignature: JSON.stringify({ type: "reasoning", id: "rs_1", summary: [] }) }, fauxText("answer two")]));
  await (await adapter.root().submit(input("r2", "second question"))).result();
  const body = await wireBody(second.seen[0]!);
  assert.ok(!JSON.stringify(body).includes("check the currency") && !JSON.stringify(body).includes("SIGNATURE-ONLY"), "the other provider's thinking is not sent to this one");
  assert.ok(JSON.stringify(body).includes("answer one"), "the words that were said are");
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(drops.map((d) => [d.model, d.dropped, d.kept]), [["openai/gpt-y", 1, 0]]);
  const event = audit.find((e) => e.type === "thinking_dropped") as Extract<AuditEvent, { type: "thinking_dropped" }>;
  assert.deepEqual([event.model, event.dropped, event.kept], ["openai/gpt-y", 1, 0]);
  // Nothing was deleted: the owner still sees both models' thinking, and the first model, resumed, receives its own again.
  assert.deepEqual((await adapter.root().thinking()).slice(0, before.length), before);
  assert.equal((await adapter.root().thinking()).length, 2);
  await adapter.root().useModel(first.ref);
  first.reply("answer three");
  await (await adapter.root().submit(input("r3", "third question"))).result();
  const back = PROVIDER_HISTORY(await wireBody(first.seen.at(-1)!));
  assert.equal(back.filter((b) => b.type === "thinking").length, 1);
  assert.equal(back.find((b) => b.type === "thinking")!.signature, "SIGNATURE-ONLY-THE-PROVIDER-NEEDS");
  // Back on the first model it is the other model's block that is left out; every request is reported once, not once per retry.
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(drops.map((d) => [d.model, d.dropped, d.kept]), [["openai/gpt-y", 1, 0], ["anthropic/claude-x", 1, 1]]);
});

test("thinkingFor and storedThinking count only what the target model can take and what is really thinking", () => {
  const assistant = (provider: string, model: string, content: unknown[]) => ({ role: "assistant", provider, api: "anthropic-messages", model, content });
  const messages = [
    assistant("anthropic", "claude-x", [SIGNED, { type: "thinking", thinking: "  " }, { type: "text", text: "hi" }]),
    assistant("anthropic", "claude-other", [{ type: "thinking", thinking: "other model", thinkingSignature: "s" }]),
    { role: "user", content: "no thinking in a user message" },
  ];
  assert.deepEqual(thinkingFor(messages, { provider: "anthropic", api: "anthropic-messages", id: "claude-x" }), { kept: 1, dropped: 1 });
  assert.deepEqual(thinkingFor(messages, { provider: "anthropic", api: "anthropic-messages", id: "nobody" }), { kept: 0, dropped: 2 }, "the empty block is neither");
  assert.deepEqual(storedThinking(7, [{ id: 1, model: [messages[2]] }, { id: 2 }, { id: 3, model: [messages[1]] }]).map((t) => [t.conversationId, t.entryId, t.model]), [[7, 3, "claude-other"]]);
});
