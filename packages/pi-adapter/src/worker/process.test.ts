import assert from "node:assert/strict";
import { PassThrough } from "node:stream";
import { test } from "node:test";
import { fauxAssistantMessage, fauxText, fauxThinking, fauxToolCall } from "@earendil-works/pi-ai";
import { MemoryStorage } from "@earendil-works/pi-durable";
import { LeaseWatchdog, LineDecoder, encodeMessage, parseFromChild, parseToChild, type ChannelStart, type FromChild, type ToChild } from "@nimblenewt/contracts";
import { createOfflineModels } from "../testing/offline.js";
import { WORK_END_TOOL } from "../bridge.js";
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
    /** The first message of that kind from `from` on; a process that never sends it fails the test after `ms` instead of hanging it. */
    next<T extends FromChild["t"]>(t: T, from = 0, ms = 45_000): Promise<Extract<FromChild, { t: T }>> {
      const deadline = Date.now() + ms;
      const found = (async (): Promise<Extract<FromChild, { t: T }>> => {
        for (;;) {
          const m = seen.slice(from).find((x) => x.t === t);
          if (m !== undefined) return m as never;
          const left = deadline - Date.now();
          if (left <= 0) throw new Error(`the process sent no ${t} within ${ms} ms`);
          await new Promise<void>((resolve) => { const timer = setTimeout(resolve, left); timer.unref(); waiters.push(() => { clearTimeout(timer); resolve(); }); });
        }
      })();
      // A wait that loses a race (`Promise.race`) and later runs out is not an unhandled rejection; an awaited one still fails its test.
      found.catch(() => undefined);
      return found;
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
  assert.deepEqual(result, { t: "result", status: "completed", text: "hello from the agent", endKind: "no-work-end", visibleChars: 20 });
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

test("after a compaction the size the process reports is what the model still sees, not the whole stored history (card H12f)", async () => {
  const { offline, hooks } = scripted();
  const long = "A long answer, said in detail. ".repeat(400);
  offline.faux.setResponses([fauxAssistantMessage(long), fauxAssistantMessage("short")]);
  const h = host(hooks);
  h.send({ t: "start", v: 1, start: { ...offlineStart, context: { compaction: { fallback: "extractive" } } } });
  await h.next("ready");
  h.send({ t: "run", requestId: "req-1", content: "say something long" });
  assert.equal((await h.next("result")).status, "completed");
  // More is said to the agent afterwards, so there is an older part to cut and a newer part to keep.
  for (const id of [50, 51]) { const mark = h.seen.length; h.send({ t: "tell", id, text: `${id}: ${"Another long message. ".repeat(400)}` }); await h.next("tell.ok", mark); }
  h.send({ t: "checkpoint", id: 40 });
  const before = (await h.next("checkpoint.ok")).contextTokens ?? 0;
  assert.ok(before > 6000, `a long conversation is stored (${before})`);
  h.send({ t: "compact", id: 41 });
  const answer = await Promise.race([h.next("compact.ok"), h.next("fault")]);
  assert.equal(answer.t, "compact.ok", JSON.stringify(answer));
  const after = answer.t === "compact.ok" ? answer.contextTokens ?? Number.MAX_SAFE_INTEGER : Number.MAX_SAFE_INTEGER;
  assert.ok(after < before - 1500, `the compacted conversation is smaller (${before} then ${after})`);
  // The summary that replaced the older part is sent to the model, so its text counts (about 6,000 characters of extract, so well over 1,000 tokens); a size of only the kept messages would undercount.
  assert.ok(after >= 1000, `the compaction summary counts toward the size (${after})`);
  h.send({ t: "checkpoint", id: 42 });
  assert.equal((await h.next("checkpoint.ok", h.seen.findIndex((m) => m.t === "compact.ok"))).contextTokens, after, "a checkpoint after the compaction reports the same size");
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

test("the owner's decisions the controller gave the process are written after every summary it makes, whatever the extract cut, and bounded on the channel (card C07q)", async () => {
  const { contextPolicyOf } = await import("./process.js");
  const keep = { note: "The owner's decisions for this task (decision version 4). Read the current ones with decision.context.", lines: ["dec-aaaaaaaaaaaaaaaaaaaa: \"[AUTHORITATIVE] Only raised beds\"", "dec-bbbbbbbbbbbbbbbbbbbb: \"[AUTHORITATIVE] Never water at noon\""] };
  const policy = contextPolicyOf({ compaction: { fallback: "extractive", keep } })!;
  // The decisions sat in the middle of the replaced messages, where the extract cuts: they are still in the summary, after it, every time it compacts.
  const text = `START ${"x".repeat(20_000)} the owner said only raised beds ${"y".repeat(20_000)} END`;
  for (let round = 0; round < 3; round++) {
    const summary = ((await policy.beforeCompact!({ key: `k${round}`, reason: "overflow", text, messageCount: 40, signal: new AbortController().signal })) as { summary: string }).summary;
    assert.ok(summary.endsWith(`${keep.note}\n- ${keep.lines[0]}\n- ${keep.lines[1]}`), summary.slice(-400));
    assert.ok(summary.length < 7000 + 1000, `still bounded (${summary.length})`);
  }
  // Nothing given, nothing added.
  const plain = ((await contextPolicyOf({ compaction: { fallback: "extractive" } })!.beforeCompact!({ key: "k", reason: "overflow", text: "short", messageCount: 1, signal: new AbortController().signal })) as { summary: string }).summary;
  assert.equal(plain.includes("owner's decisions"), false);
  // On the channel: kept as given, and bounded (at most 12 single lines).
  const line = (context: unknown): string => JSON.stringify({ t: "start", v: 1, start: { ...start, context } });
  const parsed = parseToChild(JSON.parse(line({ compaction: { fallback: "extractive", keep } }))) as { start: { context?: { compaction?: { keep?: unknown } } } };
  assert.deepEqual(parsed.start.context?.compaction?.keep, keep);
  for (const bad of [{ note: "n", lines: Array.from({ length: 13 }, () => "x") }, { note: "n", lines: ["two\nlines"] }, { note: "n", lines: ["x".repeat(601)] }, { lines: [] }, { note: "n", lines: "x" }]) assert.throws(() => parseToChild(JSON.parse(line({ compaction: { fallback: "extractive", keep: bad } }))), /./, JSON.stringify(bad));
});

/** A clock the test moves (card H08b): `sleep` moves wall time only. */
function fakeClock() {
  const c = { m: 1000, w: 1_700_000_000_000 };
  return { mono: () => c.m, wall: () => c.w, advance: (ms: number) => { c.m += ms; c.w += ms; }, sleep: (ms: number) => { c.w += ms; } };
}
const leased: ChannelStart = { ...offlineStart, lease: { leaseMs: 20_000, graceMs: 5000 } };

test("a lease that ends while a turn waits stops the turn, answers its pending call as unavailable, records the reason as the result and needs no termination (card H08b)", async () => {
  const { offline, hooks } = scripted();
  offline.faux.setResponses([fauxAssistantMessage(fauxToolCall("nimblenewt__desk-read", { recordId: "dsk-aaaaaaaaaaaaaaaaaaaa" }, { id: "c1" }), { stopReason: "toolUse" }), fauxAssistantMessage("never reached")]);
  const k = fakeClock(); let dog: LeaseWatchdog | undefined; const ended: string[] = [];
  const h = host({ ...hooks, lease: { clock: k, tickMs: 0, onWatchdog: (d) => { dog = d; }, terminate: (r) => { ended.push(r); } } });
  h.send({ t: "start", v: 1, start: leased });
  await h.next("ready");
  h.send({ t: "run", requestId: "req-1", content: "work" });
  await h.next("bridge");
  k.advance(19_000); await dog!.tick();
  assert.equal(dog!.productive, true, "still inside the lease");
  k.advance(2000); await dog!.tick();
  const result = await h.next("result");
  assert.equal(result.status, "failed");
  assert.match(result.error ?? "", /^lease lost \(silent\)/);
  assert.equal(h.seen.filter((m) => m.t === "bridge").length, 1, "no call left the process after the loss");
  k.advance(60_000); await dog!.tick();
  assert.deepEqual(ended, [], "it wound down on its own, so it is not killed");
  h.send({ t: "close" });
  await h.done;
});

test("a machine that slept loses the lease as 'wake' before any turn runs; the loss is told to the host and a later run is refused with that reason (card H08b)", async () => {
  const { hooks } = scripted();
  const k = fakeClock(); let dog: LeaseWatchdog | undefined;
  const h = host({ ...hooks, lease: { clock: k, tickMs: 0, onWatchdog: (d) => { dog = d; } } });
  h.send({ t: "start", v: 1, start: leased });
  await h.next("ready");
  k.sleep(60_000); await dog!.tick();
  assert.equal(dog!.reason, "wake");
  const told = await h.next("lease.lost");
  assert.equal(told.reason, "wake");
  h.send({ t: "run", requestId: "req-1", content: "work" });
  const second = await h.next("result", h.seen.indexOf(told) + 1);
  assert.match(second.error ?? "", /^lease lost \(wake\)/);
  assert.equal(h.seen.some((m) => m.t === "bridge"), false);
  h.send({ t: "close" });
  await h.done;
});

test("H08b3: after the loss no model call, compact, tell or checkpoint leaves the process; a clean turn does not disarm termination, and a loss with no turn is a lease.lost message", async () => {
  const { offline, hooks } = scripted();
  offline.faux.setResponses([fauxAssistantMessage("done")]);
  const k = fakeClock(); let dog: LeaseWatchdog | undefined; let quiets = 0;
  const h = host({ ...hooks, lease: { clock: k, tickMs: 0, onWatchdog: (d) => { dog = d; const q = d.quiet.bind(d); d.quiet = () => { quiets++; q(); }; }, terminate: () => undefined } });
  h.send({ t: "start", v: 1, start: leased });
  await h.next("ready");
  h.send({ t: "run", requestId: "req-1", content: "work" });
  assert.equal((await h.next("result")).status, "completed");
  assert.equal(quiets, 0, "a clean turn under a live lease does not say the process is quiet");
  k.advance(25_000); await dog!.tick();
  assert.equal((await h.next("lease.lost")).reason, "silent");
  assert.equal(quiets, 1, "quiet once the loss is told");
  const before = h.seen.length;
  await assert.rejects(fetch(`${leased.relayBase}/${leased.model.alias}/chat/completions`, { method: "POST", body: "{}" }), /lease ended/);
  for (const [i, t] of (["compact", "tell", "checkpoint"] as const).entries()) {
    const from = h.seen.length;
    h.send(t === "tell" ? { t, id: 10 + i, text: "x" } : { t, id: 10 + i });
    const f = await h.next("fault", from);
    assert.equal(f.id, 10 + i); assert.match(f.message, /lease ended \(silent\)/);
  }
  assert.equal(h.seen.slice(before).some((m) => m.t === "fetch" || m.t === "compact.ok" || m.t === "tell.ok" || m.t === "checkpoint.ok"), false);
  h.send({ t: "close" });
  await h.done;
});

/** The lease hooks of a test that drives renewals itself (card H08b). */
function driven(k: ReturnType<typeof fakeClock>, extra: NonNullable<WorkerHooks["lease"]> = {}) {
  const got: { dog?: LeaseWatchdog; renew?: () => void } = {};
  // Without its own `exit` the test must not end the test process: termination does nothing then.
  const lease: NonNullable<WorkerHooks["lease"]> = { clock: k, tickMs: 0, renewMs: 0, onWatchdog: (d: LeaseWatchdog) => { got.dog = d; }, onRenew: (r: () => void) => { got.renew = r; }, ...(extra.exit === undefined ? { terminate: () => undefined } : {}), ...extra };
  // The process's own timers do not hold the event loop (standard input does in a real process); the test holds it while it waits.
  const hold = setInterval(() => undefined, 1000);
  return { got, lease, release: () => clearInterval(hold) };
}

test("H08b: a renewal counts from its send on the process's own clock; the lease is the duration the controller meant whatever the wall clock says; a replayed or unknown answer extends nothing", async () => {
  const { offline, hooks } = scripted();
  offline.faux.setResponses([fauxAssistantMessage("done")]);
  const k = fakeClock(); k.sleep(-400 * 24 * 3600_000); // this machine's wall clock is more than a year behind
  const { got, lease, release } = driven(k);
  const h = host({ ...hooks, lease });
  h.send({ t: "start", v: 1, start: leased });
  await h.next("ready");
  assert.equal(got.dog!.remainingMs(), 20_000, "the lease the controller meant, counted from the start");
  k.advance(15_000);
  got.renew!();
  const ask = await h.next("lease.renew");
  k.advance(4000); // the answer took 4 s
  h.send({ t: "lease.ok", id: ask.id, leaseMs: 20_000 });
  h.send({ t: "lease.ok", id: 999, leaseMs: 20_000 });
  await new Promise((r) => setImmediate(r));
  assert.equal(got.dog!.remainingMs(), 16_000, "15 s + 20 s from the send, not from the answer");
  h.send({ t: "lease.ok", id: ask.id, leaseMs: 20_000 }); // the same answer again
  await new Promise((r) => setImmediate(r));
  assert.equal(got.dog!.remainingMs(), 16_000, "a replayed answer does not stretch it");
  k.advance(15_000); await got.dog!.tick();
  assert.equal(got.dog!.productive, true, "renewed: past the first lease and still working");
  h.send({ t: "run", requestId: "req-1", content: "work" });
  assert.equal((await h.next("result")).status, "completed");
  k.advance(2000); await got.dog!.tick();
  assert.equal(got.dog!.reason, "silent", "no further renewal: it ends when the renewed lease does");
  assert.equal((await h.next("lease.lost")).reason, "silent");
  h.send({ t: "close" });
  await h.done;
  release();
});

test("H08b: the renewal timer asks on its own; a lease.fenced answer stops the work at once (explicit), and nothing is asked after the loss", async () => {
  const { hooks } = scripted();
  const k = fakeClock();
  const { got, lease, release } = driven(k, { renewMs: 5 });
  const h = host({ ...hooks, lease });
  h.send({ t: "start", v: 1, start: leased });
  await h.next("ready");
  const ask = await h.next("lease.renew");
  h.send({ t: "lease.fenced", id: ask.id, reason: "the attempt is not the active attempt of its task" });
  assert.equal((await h.next("lease.lost")).reason, "explicit");
  assert.equal(got.dog!.reason, "explicit");
  const asked = h.seen.filter((m) => m.t === "lease.renew").length;
  await new Promise((r) => setTimeout(r, 40));
  got.renew!();
  assert.equal(h.seen.filter((m) => m.t === "lease.renew").length, asked, "no renewal is asked once the lease is gone");
  h.send({ t: "close" });
  await h.done;
  release();
});

test("H08b: a fenced bridge answer makes the process ask whether the lease still holds; a frozen attempt (lease.ok) goes on, a moved one (lease.fenced) stops and no further call leaves", async () => {
  for (const answer of ["ok", "fenced"] as const) {
    const { offline, hooks } = scripted();
    offline.faux.setResponses([
      fauxAssistantMessage(fauxToolCall("nimblenewt__task-get", {}, { id: "c1" }), { stopReason: "toolUse" }),
      fauxAssistantMessage(fauxToolCall("nimblenewt__task-get", {}, { id: "c2" }), { stopReason: "toolUse" }),
      fauxAssistantMessage("finished"),
    ]);
    const k = fakeClock();
    const { got, lease, release } = driven(k);
    const h = host({ ...hooks, lease });
    h.send({ t: "start", v: 1, start: leased });
    await h.next("ready");
    h.send({ t: "run", requestId: "req-1", content: "work" });
    const bridge = await h.next("bridge");
    assert.equal(h.seen.some((m) => m.t === "lease.renew"), false);
    h.send({ t: "bridge.reply", id: bridge.id, reply: { ok: false, code: "fenced", message: "the attempt is frozen: integration" } });
    const ask = await h.next("lease.renew");
    await new Promise((r) => setTimeout(r, 30));
    assert.equal(h.seen.filter((m) => m.t === "bridge").length, 1, "no further call leaves while the controller is asked");
    if (answer === "ok") {
      h.send({ t: "lease.ok", id: ask.id, leaseMs: 20_000 });
      const second = await h.next("bridge", h.seen.indexOf(bridge) + 1);
      h.send({ t: "bridge.reply", id: second.id, reply: { ok: true, result: {} } });
      assert.deepEqual(await h.next("result"), { t: "result", status: "completed", text: "finished" });
      assert.equal(got.dog!.productive, true);
    } else {
      h.send({ t: "lease.fenced", id: ask.id, reason: "the attempt has been replaced" });
      const result = await h.next("result");
      assert.match(result.error ?? "", /^lease lost \(explicit\)/);
      assert.equal(h.seen.filter((m) => m.t === "bridge").length, 1, "no call left the process after the fenced answer");
    }
    h.send({ t: "close" });
    await h.done;
    release();
  }
});

test("H08b: a turn that ignores the abort is ended inside the grace: closing the store gets at most a quarter of it, then the process exits with 75", async () => {
  const { offline, hooks } = scripted();
  // A model call that never ends and does not listen to the abort.
  let unhang!: () => void;
  offline.faux.setResponses([() => new Promise((resolve) => { unhang = () => resolve(fauxAssistantMessage("late")); })]);
  const k = fakeClock(); const exits: number[] = [];
  const { got, lease, release } = driven(k, { exit: (code: number) => { exits.push(code); } });
  const h = host({ ...hooks, lease });
  h.send({ t: "start", v: 1, start: leased }); // grace 5 s: 1 s of it is kept for closing the store
  await h.next("ready");
  h.send({ t: "run", requestId: "req-1", content: "work" });
  await new Promise((r) => setTimeout(r, 20));
  k.advance(21_000); void got.dog!.tick(); // the stop waits for an abort the turn never honours
  assert.equal(got.dog!.reason, "silent");
  k.advance(3900); await got.dog!.tick();
  assert.deepEqual(exits, [], "still inside the grace");
  k.advance(200); await got.dog!.tick();
  // The close of the store gets at most a quarter of the grace (1 s here) of real time; the store cannot close while the turn hangs, so the exit comes when that runs out.
  const asked = Date.now();
  while (exits.length === 0 && Date.now() - asked < 3000) await new Promise((r) => setTimeout(r, 20));
  assert.ok(Date.now() - asked < 1500, `the exit came ${Date.now() - asked} ms after the termination`);
  await got.dog!.tick();
  assert.deepEqual(exits, [75], "ended once, inside the 5 s grace");
  // (The test process goes on: the model call is let go so the conversation can wind down.)
  unhang();
  h.end();
  await h.done;
  release();
});

test("each completed turn carries how it ended (card W02): a length stop, a thinking-only reply, a stop without work.end, an announced step with no tool call, and a turn ended with work.end", async () => {
  const cases: { name: string; replies: ReturnType<typeof fauxAssistantMessage>[]; endKind: string; visibleChars: number }[] = [
    { name: "length", replies: [fauxAssistantMessage("The report so far: step one is", { stopReason: "length" })], endKind: "length", visibleChars: 30 },
    { name: "thinking only", replies: [fauxAssistantMessage([fauxThinking("I should look at the parser next.")])], endKind: "empty-visible-text", visibleChars: 0 },
    { name: "no work.end", replies: [fauxAssistantMessage("The parser is fixed and the tests pass.")], endKind: "no-work-end", visibleChars: 39 },
    { name: "announced step", replies: [fauxAssistantMessage([fauxThinking("tests next"), fauxText("I fixed the parser. Now let me run the tests:")])], endKind: "announced-step-without-tool-call", visibleChars: 45 },
    { name: "work.end", replies: [fauxAssistantMessage(fauxToolCall(WORK_END_TOOL, { result: "done", note: "parser fixed" }, { id: "we-1" }), { stopReason: "toolUse" }), fauxAssistantMessage("Ended: the parser is fixed.")], endKind: "normal", visibleChars: 27 },
  ];
  for (const c of cases) {
    const { offline, hooks } = scripted();
    offline.faux.setResponses(c.replies);
    const h = host(hooks);
    h.send({ t: "start", v: 1, start: offlineStart });
    await h.next("ready");
    h.send({ t: "run", requestId: "req-1", content: "fix the parser" });
    if (c.endKind === "normal") {
      const bridge = await h.next("bridge");
      assert.equal(bridge.request.op, "work.end", c.name);
      assert.deepEqual(bridge.request.args, { result: "done", note: "parser fixed" });
      h.send({ t: "bridge.reply", id: bridge.id, reply: { ok: true, result: { item: { state: "requested" } } } });
    }
    const result = await h.next("result");
    assert.equal(result.status, "completed", `${c.name}: ${JSON.stringify(result)}`);
    assert.equal(result.endKind, c.endKind, c.name);
    assert.equal(result.visibleChars, c.visibleChars, c.name);
    h.send({ t: "close" });
    await h.done;
  }
});

test("a work.end the controller refused is not an ending: the turn that stops after it is a stop without work.end (card W02)", async () => {
  const { offline, hooks } = scripted();
  offline.faux.setResponses([fauxAssistantMessage(fauxToolCall(WORK_END_TOOL, { result: "done" }, { id: "we-1" }), { stopReason: "toolUse" }), fauxAssistantMessage("I am done.")]);
  const h = host(hooks);
  h.send({ t: "start", v: 1, start: offlineStart });
  await h.next("ready");
  h.send({ t: "run", requestId: "req-1", content: "finish" });
  const bridge = await h.next("bridge");
  h.send({ t: "bridge.reply", id: bridge.id, reply: { ok: false, code: "paused", message: "the task is paused" } });
  const result = await h.next("result");
  assert.equal(result.endKind, "no-work-end");
  h.send({ t: "close" });
  await h.done;
});
