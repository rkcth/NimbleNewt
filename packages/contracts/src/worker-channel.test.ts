import assert from "node:assert/strict";
import { test } from "node:test";
import { ChannelError, LineDecoder, MAX_CHANNEL_LINE_BYTES, encodeMessage, parseFromChild, parseToChild, type ChannelStart, type FromChild, type ToChild } from "./index.js";

const start: ChannelStart = {
  attemptId: "att-1", agentId: "agent:ann", namespaceId: "abcdef0123456789", credential: "tok", storeDir: "/home/agent/pi", relayBase: "http://relay.invalid",
  model: { alias: "m0", provider: "llama", api: "openai-completions", modelId: "local", contextWindow: 32768, maxTokens: 1024, reasoning: false, input: ["text"] },
  cache: { key: "k", retention: "short" },
};

test("every message of both directions survives a round trip through the line codec", () => {
  const toChild: ToChild[] = [
    { t: "start", v: 1, start }, { t: "run", requestId: "req-1", content: "do it" }, { t: "checkpoint", id: 3 }, { t: "tell", id: 4, text: "hello\nworld" }, { t: "compact", id: 5 }, { t: "close" },
    { t: "bridge.reply", id: 5, reply: { ok: true, result: { a: 1 } } }, { t: "bridge.reply", id: 6, reply: { ok: false, code: "paused", message: "no" } },
    { t: "fetch.head", id: 7, status: 200, statusText: "OK", headers: [["content-type", "text/event-stream"]] }, { t: "fetch.chunk", id: 7, data: Buffer.from("data: x\n\n").toString("base64") }, { t: "fetch.end", id: 7 }, { t: "fetch.error", id: 8, message: "refused" },
  ];
  const fromChild: FromChild[] = [
    { t: "ready", v: 1 }, { t: "bridge", id: 1, token: "tok", request: { op: "desk.read", callId: "c1", args: { recordId: "x" } } }, { t: "bridge", id: 2, token: "tok", request: { op: "task.get", callId: "c2" } },
    { t: "fetch", id: 9, url: "http://relay.invalid/m0/v1/chat/completions", method: "POST", headers: [["accept", "*/*"]], body: Buffer.from("{}").toString("base64") }, { t: "fetch", id: 10, url: "http://relay.invalid/m0/x", method: "GET", headers: [] },
    { t: "fetch.abort", id: 9 }, { t: "result", status: "completed", text: "ok" }, { t: "result", status: "failed", error: "boom" }, { t: "compact.ok", id: 4, contextTokens: 900 }, { t: "compact.ok", id: 5 }, { t: "checkpoint.ok", id: 3, checkpoint: { n: 1 } }, { t: "tell.ok", id: 4 }, { t: "fault", message: "bad" }, { t: "fault", id: 3, message: "bad" },
  ];
  const decoder = new LineDecoder();
  for (const m of toChild) assert.deepEqual(parseToChild(decoder.push(encodeMessage(m))[0]), m);
  for (const m of fromChild) assert.deepEqual(parseFromChild(decoder.push(encodeMessage(m))[0]), m);
});

test("lines arrive in pieces and in bunches", () => {
  const decoder = new LineDecoder();
  const a = encodeMessage({ t: "close" }); const b = encodeMessage({ t: "tell", id: 1, text: "é ü ✓" });
  const bytes = Buffer.from(a + b);
  const seen: unknown[] = [];
  for (let i = 0; i < bytes.length; i += 3) seen.push(...decoder.push(bytes.subarray(i, i + 3)));
  assert.deepEqual(seen, [{ t: "close" }, { t: "tell", id: 1, text: "é ü ✓" }]);
  assert.deepEqual(decoder.push(`${a}${a}`), [{ t: "close" }, { t: "close" }]);
});

test("a line that is too long, or not JSON, ends the channel with a ChannelError", () => {
  assert.throws(() => new LineDecoder().push("{not json}\n"), ChannelError);
  assert.throws(() => new LineDecoder().push(Buffer.alloc(MAX_CHANNEL_LINE_BYTES + 1, 97)), ChannelError);
  assert.throws(() => new LineDecoder().push(`${"x".repeat(MAX_CHANNEL_LINE_BYTES + 1)}\n`), ChannelError);
  assert.throws(() => encodeMessage({ t: "fetch.error", id: 1, message: "x".repeat(MAX_CHANNEL_LINE_BYTES) }), ChannelError);
});

test("messages that do not fit are refused whichever side sent them", () => {
  const bad: unknown[] = [null, [], 5, {}, { t: "nope" }, { t: "bridge", id: -1, token: "t", request: { op: "x", callId: "y" } }, { t: "bridge", id: 1.5, token: "t", request: { op: "x", callId: "y" } }, { t: "bridge", id: 1, token: 5, request: { op: "x", callId: "y" } },
    { t: "bridge", id: 1, token: "t", request: { op: "x" } }, { t: "bridge", id: 1, token: "t", request: { op: "x", callId: "y", args: [] } }, { t: "fetch", id: 1, url: "u", method: "GET", headers: [["a"]] }, { t: "fetch", id: 1, url: "u", method: "GET", headers: [], body: "not base64!" },
    { t: "result", status: "done" }, { t: "checkpoint.ok", id: 1, checkpoint: [] }, { t: "fault", message: 5 }];
  for (const m of bad) assert.throws(() => parseFromChild(m), ChannelError, JSON.stringify(m));
  const badDown: unknown[] = [{ t: "start", v: 1, start: { ...start, model: { ...start.model, alias: "Bad Alias" } } }, { t: "start", v: 1, start: { ...start, cache: { retention: "forever" } } }, { t: "start", v: 1, start: { ...start, model: { ...start.model, input: ["video"] } } },
    { t: "bridge.reply", id: 1, reply: { ok: "yes" } }, { t: "fetch.chunk", id: 1, data: "***" }, { t: "fetch.head", id: 1, status: 200, statusText: "OK", headers: [[1, 2]] }, { t: "tell", id: 1 }, { t: "nope" }];
  for (const m of badDown) assert.throws(() => parseToChild(m), ChannelError, JSON.stringify(m));
});

test("a credential and the host's own fields are not part of a start the process can forge for another attempt: the start carries exactly the fields it names", () => {
  const parsed = parseToChild(JSON.parse(JSON.stringify({ t: "start", v: 1, start: { ...start, extra: "ignored", model: { ...start.model, secret: "x" } } })));
  assert.equal(parsed.t, "start");
  assert.deepEqual(Object.keys((parsed as { start: ChannelStart }).start).sort(), ["agentId", "attemptId", "cache", "credential", "model", "namespaceId", "relayBase", "storeDir"]);
  assert.deepEqual(Object.keys((parsed as { start: ChannelStart }).start.model).sort(), ["alias", "api", "contextWindow", "input", "maxTokens", "modelId", "provider", "reasoning"]);
});

test("a start may carry the lease as a duration and a grace; bad or partial leases are refused (card H08b)", () => {
  const ok = parseToChild(JSON.parse(JSON.stringify({ t: "start", v: 1, start: { ...start, lease: { leaseMs: 20_000, graceMs: 5000 } } })));
  assert.deepEqual((ok as { start: ChannelStart }).start.lease, { leaseMs: 20_000, graceMs: 5000 });
  assert.equal((parseToChild(JSON.parse(JSON.stringify({ t: "start", v: 1, start }))) as { start: ChannelStart }).start.lease, undefined);
  for (const lease of [{ leaseMs: 20_000 }, { graceMs: 5 }, { leaseMs: 5, graceMs: 5 }, { leaseMs: "20000", graceMs: 5 }, { leaseMs: 10_000_000, graceMs: 5 }, []]) {
    assert.throws(() => parseToChild(JSON.parse(JSON.stringify({ t: "start", v: 1, start: { ...start, lease } }))), ChannelError);
  }
});
