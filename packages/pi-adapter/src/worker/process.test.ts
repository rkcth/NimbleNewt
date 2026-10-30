import assert from "node:assert/strict";
import { PassThrough } from "node:stream";
import { test } from "node:test";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { MemoryStorage } from "@earendil-works/pi-durable";
import { LineDecoder, encodeMessage, parseFromChild, parseToChild, type ChannelStart, type FromChild, type ToChild } from "@nimblenewt/contracts";
import { createOfflineModels } from "../testing/offline.js";
import { runWorker, type WorkerHooks } from "./process.js";

const start: ChannelStart = {
  attemptId: "att-1", agentId: "agent:ann", namespaceId: "abcdef0123456789", credential: "task-credential", storeDir: "/home/agent/pi", relayBase: "http://relay.invalid",
  model: { alias: "m0", provider: "llama", api: "openai-completions", modelId: "local", contextWindow: 32768, maxTokens: 1024, reasoning: false, input: ["text"] },
};

/** The host's side of the channel, in the test's hands. */
function host(hooks: WorkerHooks) {
  const toChild = new PassThrough();
  const seen: FromChild[] = [];
  const discovers: string[] = [];
  const waiters: (() => void)[] = [];
  const decoder = new LineDecoder();
  const done = runWorker({ input: toChild, write: (text) => { for (const raw of decoder.push(text)) {
    const m = parseFromChild(raw);
    // The declarations at the start of a request are answered here and kept apart from what the tests look at.
    if (m.t === "bridge" && m.request.op === "tool.discover") { discovers.push(m.request.callId); toChild.write(encodeMessage({ t: "bridge.reply", id: m.id, reply: { ok: true, result: { revision: "r1", tools: [{ name: "a_abc.shout", kind: "tool", version: "1.2.0" }] } } })); continue; }
    seen.push(m); for (const w of waiters.splice(0)) w();
  } } }, hooks);
  return {
    seen, done, discovers,
    send: (m: ToChild): void => { toChild.write(encodeMessage(m)); },
    end: (): void => { toChild.end(); },
    async next<T extends FromChild["t"]>(t: T, from = 0): Promise<Extract<FromChild, { t: T }>> {
      for (;;) {
        const found = seen.slice(from).find((m) => m.t === t);
        if (found !== undefined) return found as never;
        await new Promise<void>((resolve) => waiters.push(resolve));
      }
    },
  };
}

const relayed: ChannelStart = start;
const offlineStart: ChannelStart = { ...start, model: { ...start.model, provider: "offline", modelId: "scripted" } };

const scripted = () => { const offline = createOfflineModels(); return { offline, hooks: { models: () => offline.models, storage: () => new MemoryStorage() } satisfies WorkerHooks }; };

test("the process starts on the host's word, runs the turn, reaches the bridge only over the channel with the credential it was given, and reports the result", async () => {
  const { offline, hooks } = scripted();
  offline.faux.setResponses([
    fauxAssistantMessage(fauxToolCall("nimblenewt__desk-read", { recordId: "dsk-aaaaaaaaaaaaaaaaaaaa" }, { id: "call:1|odd" }), { stopReason: "toolUse" }),
    fauxAssistantMessage("hello from the agent"),
  ]);
  const h = host(hooks);
  h.send({ t: "start", v: 1, start: offlineStart });
  await h.next("ready");
  h.send({ t: "run", requestId: "req-1", content: "say hello" });
  const bridge = await h.next("bridge");
  assert.equal(bridge.token, "task-credential");
  assert.equal(bridge.request.op, "desk.read");
  assert.deepEqual(bridge.request.args, { recordId: "dsk-aaaaaaaaaaaaaaaaaaaa" });
  assert.match(bridge.request.callId, /^h:[0-9a-f]{40}$/, "a provider call ID the controller would refuse is replaced by a digest of itself");
  h.send({ t: "bridge.reply", id: bridge.id, reply: { ok: true, result: { record: { id: "dsk-aaaaaaaaaaaaaaaaaaaa" } } } });
  const result = await h.next("result");
  assert.deepEqual(result, { t: "result", status: "completed", text: "hello from the agent" });
  h.send({ t: "checkpoint", id: 7 });
  const cp = await h.next("checkpoint.ok");
  assert.equal(cp.id, 7);
  assert.equal(typeof cp.checkpoint, "object");
  h.send({ t: "tell", id: 8, text: "the recipe was widened" });
  assert.deepEqual(await h.next("tell.ok"), { t: "tell.ok", id: 8 });
  h.send({ t: "close" });
  await h.done;
});

test("a message told while a turn waits on the bridge is accepted at once, does not end the turn, and is in front of the model on its next call (card H12f)", async () => {
  const { offline, hooks } = scripted();
  const seenByModel: string[] = [];
  offline.faux.setResponses([
    (context) => { seenByModel.push(JSON.stringify(context.messages)); return fauxAssistantMessage(fauxToolCall("nimblenewt__desk-read", { recordId: "dsk-aaaaaaaaaaaaaaaaaaaa" }, { id: "c1" }), { stopReason: "toolUse" }); },
    (context) => { seenByModel.push(JSON.stringify(context.messages)); return fauxAssistantMessage("carried on"); },
  ]);
  const h = host(hooks);
  h.send({ t: "start", v: 1, start: offlineStart });
  await h.next("ready");
  h.send({ t: "run", requestId: "req-1", content: "do the thing" });
  const bridge = await h.next("bridge");
  // The turn is now waiting for the controller's reply; the host tells the agent something.
  h.send({ t: "tell", id: 21, text: "INTERRUPT-X: the owner changed the plan" });
  // It is answered while the turn is still waiting: nothing on the host side is held up until the turn ends.
  const told = await Promise.race([h.next("tell.ok"), h.next("fault")]);
  assert.deepEqual(told, { t: "tell.ok", id: 21 });
  assert.equal(h.seen.some((m) => m.t === "result"), false, "the turn had not ended");
  h.send({ t: "bridge.reply", id: bridge.id, reply: { ok: true, result: { record: { id: "dsk-aaaaaaaaaaaaaaaaaaaa" } } } });
  const result = await h.next("result");
  assert.equal(result.status, "completed", JSON.stringify(result));
  assert.ok(!seenByModel[0]!.includes("INTERRUPT-X"), "it was told after the first call");
  assert.ok(seenByModel[1]!.includes("INTERRUPT-X"), "the model sees it on its next call");
  h.send({ t: "close" });
  await h.done;
});

test("the host can ask the process to compact its stored conversation: it answers with the new size, or a fault with the same ID, and the process goes on (card H12f)", async () => {
  const { offline, hooks } = scripted();
  offline.faux.setResponses([fauxAssistantMessage("first answer"), fauxAssistantMessage("a summary of the conversation"), fauxAssistantMessage("second answer")]);
  const h = host(hooks);
  h.send({ t: "start", v: 1, start: offlineStart });
  await h.next("ready");
  h.send({ t: "run", requestId: "req-1", content: "say something" });
  assert.equal((await h.next("result")).status, "completed");
  h.send({ t: "compact", id: 31 });
  const answer = await Promise.race([h.next("compact.ok"), h.next("fault")]);
  assert.equal(answer.t, "compact.ok", JSON.stringify(answer));
  assert.equal(answer.id, 31);
  h.send({ t: "checkpoint", id: 32 });
  assert.equal((await h.next("checkpoint.ok")).id, 32, "the process answers after compacting");
  h.send({ t: "close" });
  await h.done;
});

test("a refused bridge call is the model's tool result, not a crash; garbage on the channel is a fault, not a crash", async () => {
  const { offline, hooks } = scripted();
  offline.faux.setResponses([
    fauxAssistantMessage(fauxToolCall("nimblenewt__task-get", {}, { id: "c1" }), { stopReason: "toolUse" }),
    (context) => fauxAssistantMessage(`saw: ${/a_abc.shout 1.2.0/.test(JSON.stringify(context.messages)) ? "catalogue " : ""}${/refused \(paused\)/.test(JSON.stringify(context.messages.slice(-1))) ? "refusal" : "nothing"}`),
  ]);
  const h = host(hooks);
  h.send({ t: "start", v: 1, start: offlineStart });
  await h.next("ready");
  h.send({ t: "run", requestId: "req-1", content: "say hello" });
  const bridge = await h.next("bridge");
  h.send({ t: "bridge.reply", id: bridge.id, reply: { ok: false, code: "paused", message: "the task is paused" } });
  assert.deepEqual(await h.next("result"), { t: "result", status: "completed", text: "saw: catalogue refusal" });
  assert.equal(h.discovers.length, 1, "one snapshot of the declarations per request");
  h.send({ t: "tell", id: 1 } as never);
  const fault = await h.next("fault");
  assert.match(fault.message, /text/);
  h.send({ t: "close" });
  await h.done;
});

test("a start the process cannot honour is a fault, and the process starts only once", async () => {
  const { hooks } = scripted();
  const h = host({ ...hooks, models: () => { throw new Error("no such model"); } });
  h.send({ t: "start", v: 1, start: offlineStart });
  assert.match((await h.next("fault")).message, /could not start: no such model/);
  h.send({ t: "run", requestId: "req-1", content: "say hello" });
  assert.match((await h.next("fault", 1)).message, /not started/);
  h.send({ t: "close" });
  await h.done;
  const wrong = host(hooks);
  wrong.send({ t: "start", v: 99, start: offlineStart });
  assert.match((await wrong.next("fault")).message, /version 1, not 99/);
  wrong.end();
  await wrong.done;
});

test("model calls go over the channel to the host's relay and nowhere else; the process reads no network and no provider key", async () => {
  const { storage } = scripted().hooks;
  const h = host({ storage });
  h.send({ t: "start", v: 1, start });
  await h.next("ready");
  h.send({ t: "run", requestId: "req-1", content: "say hello" });
  const call = await h.next("fetch");
  assert.equal(call.url, "http://relay.invalid/m0/chat/completions");
  assert.equal(call.method, "POST");
  const body = JSON.parse(Buffer.from(call.body ?? "", "base64").toString("utf8")) as { model: string; stream?: boolean };
  assert.equal(body.model, "local");
  assert.ok(!JSON.stringify(call.headers).includes("sk-"), "no provider credential is in the request");
  const sse = (obj: unknown): string => `data: ${JSON.stringify(obj)}\n\n`;
  const chunks = [
    sse({ id: "c1", object: "chat.completion.chunk", created: 1, model: "local", choices: [{ index: 0, delta: { role: "assistant", content: "relayed " }, finish_reason: null }] }),
    sse({ id: "c1", object: "chat.completion.chunk", created: 1, model: "local", choices: [{ index: 0, delta: { content: "answer" }, finish_reason: null }] }),
    sse({ id: "c1", object: "chat.completion.chunk", created: 1, model: "local", choices: [{ index: 0, delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 5, completion_tokens: 2, total_tokens: 7 } }),
    "data: [DONE]\n\n",
  ];
  h.send({ t: "fetch.head", id: call.id, status: 200, statusText: "OK", headers: [["content-type", "text/event-stream"]] });
  for (const c of chunks) h.send({ t: "fetch.chunk", id: call.id, data: Buffer.from(c).toString("base64") });
  h.send({ t: "fetch.end", id: call.id });
  assert.deepEqual(await h.next("result"), { t: "result", status: "completed", text: "relayed answer" });
  // Anything but the relay's address fails inside the process, without a message to the host.
  const before = h.seen.length;
  await assert.rejects(fetch("https://example.com/"), /there is no network here/);
  await assert.rejects(fetch("http://relay.invalid.evil.example/m0/x"), /there is no network here/);
  assert.equal(h.seen.length, before);
  h.send({ t: "close" });
  await h.done;
});

test("a model error from the relay fails the turn with its reason, and a host that goes away ends the process", async () => {
  const { storage } = scripted().hooks;
  const h = host({ storage });
  h.send({ t: "start", v: 1, start });
  await h.next("ready");
  h.send({ t: "run", requestId: "req-1", content: "say hello" });
  // The SDK tries again after a failed call: the host refuses every try.
  const answered = new Set<number>();
  const refuse = setInterval(() => { for (const m of h.seen) if (m.t === "fetch" && !answered.has(m.id)) { answered.add(m.id); h.send({ t: "fetch.error", id: m.id, message: "that destination is not allowed" }); } }, 10);
  try {
    const result = await h.next("result");
    assert.equal(result.status, "failed");
    assert.match(result.error ?? "", /did not answer|fetch failed|not allowed/);
    assert.ok(answered.size >= 1);
  } finally { clearInterval(refuse); }
  h.end();
  await h.done;
});

test("a provider call ID that repeats is sent to the controller under a new one, so it cannot stand for the earlier request", async () => {
  const { offline, hooks } = scripted();
  offline.faux.setResponses([
    fauxAssistantMessage(fauxToolCall("nimblenewt__desk-read", { recordId: "dsk-aaaaaaaaaaaaaaaaaaaa" }, { id: "call_0" }), { stopReason: "toolUse" }),
    fauxAssistantMessage(fauxToolCall("nimblenewt__desk-read", { recordId: "dsk-bbbbbbbbbbbbbbbbbbbb" }, { id: "call_0" }), { stopReason: "toolUse" }),
    fauxAssistantMessage("done"),
  ]);
  const h = host(hooks);
  h.send({ t: "start", v: 1, start: offlineStart });
  await h.next("ready");
  h.send({ t: "run", requestId: "req-1", content: "read two" });
  const first = await h.next("bridge");
  h.send({ t: "bridge.reply", id: first.id, reply: { ok: true, result: {} } });
  const second = await h.next("bridge", h.seen.indexOf(first) + 1);
  assert.equal(first.request.callId, "call_0");
  assert.match(second.request.callId, /^d:[0-9a-f]{40}$/);
  h.send({ t: "bridge.reply", id: second.id, reply: { ok: true, result: {} } });
  assert.equal((await h.next("result")).status, "completed");
  h.send({ t: "close" });
  await h.done;
});

test("the host's context limits reach Pi's policy; the extractive fallback never asks the model, is bounded, and says it is an extract; bad limits are refused on the channel", async () => {
  const { contextPolicyOf } = await import("./process.js");
  assert.equal(contextPolicyOf(undefined), undefined);
  const policy = contextPolicyOf({ streamTimeoutMs: 60_000, streamMaxRetries: 1, toolOutputBytes: 20_000, toolOutputLines: 500, compaction: { timeoutMs: 5000, fallback: "extractive" } })!;
  assert.deepEqual([policy.streamTimeoutMs, policy.streamMaxRetries, policy.toolOutputBytes, policy.toolOutputLines, policy.beforeCompactTimeoutMs], [60_000, 1, 20_000, 500, 5000]);
  const text = `START-OF-TASK ${"x".repeat(50_000)} END-WHERE-WE-STAND`;
  const decision = await policy.beforeCompact!({ key: "k", reason: "overflow", text, messageCount: 40, signal: new AbortController().signal });
  const summary = (decision as { summary: string }).summary;
  assert.ok(summary.length < 7000, `bounded (${summary.length})`);
  assert.match(summary, /START-OF-TASK/); assert.match(summary, /END-WHERE-WE-STAND/); assert.match(summary, /Extract of 40 earlier messages/); assert.match(summary, /characters left out/);
  // No cut falls inside a surrogate pair, wherever the bound lands.
  for (const pad of [0, 1]) {
    const emoji = `${"a".repeat(pad)}${"😀".repeat(5000)}`;
    const s2 = ((await policy.beforeCompact!({ key: "k", reason: "overflow", text: emoji, messageCount: 2, signal: new AbortController().signal })) as { summary: string }).summary;
    assert.equal(/[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/.test(s2), false, "a lone surrogate half");
  }
  // Without the fallback Pi's own summariser runs (no hook).
  assert.equal(contextPolicyOf({ compaction: { timeoutMs: 5000 } })!.beforeCompact, undefined);
  // On the channel.
  const line = (context: unknown): string => JSON.stringify({ t: "start", v: 1, start: { ...start, context } });
  assert.deepEqual(parseToChild(JSON.parse(line({ streamTimeoutMs: 60_000, compaction: { fallback: "extractive" } }))) !== undefined, true);
  for (const bad of [{ streamTimeoutMs: 5 }, { streamMaxRetries: 99 }, { toolOutputBytes: -1 }, { compaction: { fallback: "model" } }, { compaction: { timeoutMs: 1 } }]) assert.throws(() => parseToChild(JSON.parse(line(bad))), /./, JSON.stringify(bad));
});
