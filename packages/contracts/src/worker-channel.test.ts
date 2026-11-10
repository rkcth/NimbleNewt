import assert from "node:assert/strict";
import { test } from "node:test";
import { ChannelError, LineDecoder, MAX_CHANNEL_LINE_BYTES, MAX_TURN_NUDGES, TURN_END_KINDS, encodeMessage, endKindOf, parseFromChild, parseToChild, type ChannelStart, type FromChild, type ToChild } from "./index.js";

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
    { t: "fetch.abort", id: 9 }, { t: "result", status: "completed", text: "ok" }, { t: "result", status: "completed", text: "ok", endKind: "no-work-end", visibleChars: 2 }, { t: "result", status: "failed", error: "boom" }, { t: "compact.ok", id: 4, contextTokens: 900 }, { t: "compact.ok", id: 5 }, { t: "checkpoint.ok", id: 3, checkpoint: { n: 1 } }, { t: "checkpoint.ok", id: 6, checkpoint: { n: 2 }, durable: { verified: true } }, { t: "checkpoint.ok", id: 7, checkpoint: { n: 3 }, durable: { verified: false, error: "history_changed" } }, { t: "tell.ok", id: 4 }, { t: "fault", message: "bad" }, { t: "fault", id: 3, message: "bad" },
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
    { t: "result", status: "done" }, { t: "checkpoint.ok", id: 1, checkpoint: [] }, { t: "fault", message: 5 },
    // Card L04d: a durability check that does not say whether it passed, or whose reason is too long, is refused rather than read as passed.
    { t: "checkpoint.ok", id: 1, checkpoint: {}, durable: {} }, { t: "checkpoint.ok", id: 1, checkpoint: {}, durable: { verified: "yes" } }, { t: "checkpoint.ok", id: 1, checkpoint: {}, durable: true }, { t: "checkpoint.ok", id: 1, checkpoint: {}, durable: { verified: false, error: "x".repeat(301) } }];
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

test("H08b: a renewal is asked by ID and answered as a duration or as fenced; bad answers are refused", () => {
  assert.deepEqual(parseFromChild({ t: "lease.renew", id: 3 }), { t: "lease.renew", id: 3 });
  assert.deepEqual(parseToChild({ t: "lease.ok", id: 3, leaseMs: 60_000 }), { t: "lease.ok", id: 3, leaseMs: 60_000 });
  assert.deepEqual(parseToChild({ t: "lease.fenced", id: 3, reason: "moved" }), { t: "lease.fenced", id: 3, reason: "moved" });
  for (const bad of [{ t: "lease.renew" }, { t: "lease.renew", id: -1 }]) assert.throws(() => parseFromChild(bad), ChannelError);
  for (const bad of [{ t: "lease.ok", id: 3 }, { t: "lease.ok", id: 3, leaseMs: "60000" }, { t: "lease.ok", id: 3, leaseMs: 3_600_001 }, { t: "lease.ok", id: 3, leaseMs: -5 }, { t: "lease.fenced", id: 3 }, { t: "lease.fenced", id: 3, reason: "x".repeat(501) }]) {
    assert.throws(() => parseToChild(bad), ChannelError, JSON.stringify(bad).slice(0, 80));
  }
});

test("a start may say the controller reviewed the unfinished work of an earlier process (card H12b); a bad or empty reason is refused", () => {
  const ok = parseToChild(JSON.parse(JSON.stringify({ t: "start", v: 1, start: { ...start, recover: { reason: "the controller restarted the sandbox" } } })));
  assert.deepEqual((ok as { start: ChannelStart }).start.recover, { reason: "the controller restarted the sandbox" });
  assert.equal((parseToChild(JSON.parse(JSON.stringify({ t: "start", v: 1, start }))) as { start: ChannelStart }).start.recover, undefined, "absent unless said");
  for (const recover of [{}, { reason: "" }, { reason: 5 }, { reason: "x".repeat(301) }, [], "yes"]) {
    assert.throws(() => parseToChild(JSON.parse(JSON.stringify({ t: "start", v: 1, start: { ...start, recover } }))), ChannelError, JSON.stringify(recover));
  }
});

test("a turn's end kind (card W02): each known kind passes, one this side does not know is left out (read as unknown, never normal), and the visible length is a whole number", () => {
  for (const endKind of TURN_END_KINDS) assert.deepEqual(parseFromChild({ t: "result", status: "completed", text: "x", endKind, visibleChars: 1 }), { t: "result", status: "completed", text: "x", endKind, visibleChars: 1 });
  assert.deepEqual(parseFromChild({ t: "result", status: "completed", text: "x", endKind: "finished-nicely" }), { t: "result", status: "completed", text: "x" });
  assert.deepEqual(parseFromChild({ t: "result", status: "completed", text: "x", endKind: "unknown" }), { t: "result", status: "completed", text: "x" });
  for (const bad of [{ endKind: 5 }, { visibleChars: -1 }, { visibleChars: 1.5 }, { visibleChars: "3" }]) assert.throws(() => parseFromChild({ t: "result", status: "completed", ...bad }), ChannelError, JSON.stringify(bad));
  assert.equal(endKindOf(undefined), "unknown");
  assert.equal(endKindOf("Normal"), "unknown");
  assert.equal(endKindOf("normal"), "normal");
});

test("a turn's nudges (card W04): a whole number up to the bound on any result; anything else is refused", () => {
  assert.deepEqual(parseFromChild({ t: "result", status: "completed", text: "x", endKind: "normal", nudges: 2 }), { t: "result", status: "completed", text: "x", endKind: "normal", nudges: 2 });
  assert.deepEqual(parseFromChild({ t: "result", status: "failed", error: "e", nudges: 0 }), { t: "result", status: "failed", error: "e", nudges: 0 });
  assert.deepEqual(parseFromChild({ t: "result", status: "cancelled" }), { t: "result", status: "cancelled" });
  for (const nudges of [-1, 1.5, "2", MAX_TURN_NUDGES + 1]) assert.throws(() => parseFromChild({ t: "result", status: "completed", nudges }), ChannelError, JSON.stringify(nudges));
});
