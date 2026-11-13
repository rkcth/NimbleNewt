import assert from "node:assert/strict";
import { test } from "node:test";
import { ChannelError, LineDecoder, MAX_CHANNEL_LINE_BYTES, MAX_TURN_NUDGES, THINKING_REPORT, TURN_END_KINDS, encodeMessage, endKindOf, parseFromChild, parseToChild, type ChannelStart, type FromChild, type ToChild } from "./index.js";

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
    { t: "fetch.abort", id: 9 }, { t: "result", status: "completed", text: "ok" }, { t: "result", status: "completed", text: "ok", endKind: "no-work-end", visibleChars: 2 }, { t: "result", status: "failed", error: "boom" }, { t: "compact.ok", id: 4, contextTokens: 900 }, { t: "compact.ok", id: 5 }, { t: "compacted", messageCount: 40, summaryChars: 900, digest: "a".repeat(64) }, { t: "checkpoint.ok", id: 3, checkpoint: { n: 1 } }, { t: "checkpoint.ok", id: 6, checkpoint: { n: 2 }, durable: { verified: true } }, { t: "checkpoint.ok", id: 7, checkpoint: { n: 3 }, durable: { verified: false, error: "history_changed" } }, { t: "tell.ok", id: 4 }, { t: "fault", message: "bad" }, { t: "fault", id: 3, message: "bad" },
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

test("a compacted notice carries the count, the summary length and a sha-256 digest, and nothing else is accepted (card C07q)", () => {
  const ok = { t: "compacted", messageCount: 3, summaryChars: 10, digest: "0".repeat(64) };
  assert.deepEqual(parseFromChild(ok), ok);
  for (const bad of [{ ...ok, digest: "G".repeat(64) }, { ...ok, digest: "0".repeat(63) }, { ...ok, messageCount: -1 }, { ...ok, messageCount: undefined }, { ...ok, summaryChars: 1.5 }, { ...ok, summaryChars: undefined }, { ...ok, messageCount: 10_000_001 }]) assert.throws(() => parseFromChild(bad), ChannelError);
});

test("a thinking report carries bounded blocks of untrusted text and nothing else is accepted (card U09b)", () => {
  const block = { entryId: 4, block: 0, provider: "llama", model: "local", text: "I should read the file first.", opaque: false };
  const ok = { t: "thinking", blocks: [block, { ...block, block: 1, text: "", opaque: true }] };
  assert.deepEqual(parseFromChild(ok), ok);
  assert.deepEqual(parseFromChild({ t: "thinking", blocks: [{ ...block, text: "x".repeat(THINKING_REPORT.parseChars) }] }).t, "thinking");
  const many = Array.from({ length: THINKING_REPORT.blocks + 1 }, (_, i) => ({ ...block, block: i }));
  for (const bad of [
    { t: "thinking" }, { t: "thinking", blocks: [] }, { t: "thinking", blocks: many }, { t: "thinking", blocks: "x" }, { t: "thinking", blocks: [5] },
    { t: "thinking", blocks: [{ ...block, text: "x".repeat(THINKING_REPORT.parseChars + 1) }] }, { t: "thinking", blocks: [{ ...block, entryId: -1 }] }, { t: "thinking", blocks: [{ ...block, block: 1.5 }] },
    { t: "thinking", blocks: [{ ...block, opaque: "no" }] }, { t: "thinking", blocks: [{ ...block, model: "" }] }, { t: "thinking", blocks: [{ ...block, provider: "p".repeat(81) }] }, { t: "thinking", blocks: [{ ...block, text: 7 }] },
  ]) assert.throws(() => parseFromChild(bad), ChannelError, JSON.stringify(bad).slice(0, 80));
  assert.deepEqual(parseFromChild(many.slice(0, THINKING_REPORT.blocks).length === THINKING_REPORT.blocks ? { t: "thinking", blocks: many.slice(0, THINKING_REPORT.blocks) } : {}).t, "thinking");
});

test("H12i: the network messages of both directions round-trip, and what does not fit is refused whichever side sent it", () => {
  const decoder = new LineDecoder();
  const data = Buffer.alloc(256 * 1024, 5).toString("base64");
  const toChild: ToChild[] = [
    { t: "net.opened", id: 1 }, { t: "net.refused", id: 2, message: "the task holds no grant for that destination" }, { t: "net.data", id: 3, data }, { t: "net.ack", id: 3 }, { t: "net.close", id: 3 }, { t: "net.close", id: 4, message: "the grant was revoked" },
    { t: "start", v: 1, start: { ...start, network: { proxyPort: 3128 } } },
  ];
  const fromChild: FromChild[] = [{ t: "net.open", id: 1, host: "docs.example.com", port: 443 }, { t: "net.data", id: 1, data }, { t: "net.end", id: 1 }, { t: "net.close", id: 1 }, { t: "net.ack", id: 1 }];
  for (const m of toChild) assert.deepEqual(parseToChild(decoder.push(encodeMessage(m))[0]), m);
  for (const m of fromChild) assert.deepEqual(parseFromChild(decoder.push(encodeMessage(m))[0]), m);
  for (const bad of [{ t: "net.open", id: 1, host: "x".repeat(261), port: 443 }, { t: "net.open", id: 1, host: "a.example.com", port: 0 }, { t: "net.open", id: 1, host: "a.example.com", port: 65536 }, { t: "net.open", id: 1, host: "a.example.com", port: "443" }, { t: "net.open", id: "1", host: "a.example.com", port: 443 }, { t: "net.open", id: 1, host: "a.example.com" }, { t: "net.data", id: 1, data: "not base64!" }, { t: "net.data", id: 1 }, { t: "net.end" }])
    assert.throws(() => parseFromChild(bad), ChannelError, JSON.stringify(bad).slice(0, 80));
  for (const bad of [{ t: "net.refused", id: 1 }, { t: "net.refused", id: 1, message: "x".repeat(2001) }, { t: "net.opened" }, { t: "net.data", id: 1, data: "!!" }, { t: "net.close", id: 1, message: 5 }, { t: "net.end", id: 1 }])
    assert.throws(() => parseToChild(bad), ChannelError, JSON.stringify(bad).slice(0, 80));
  for (const port of [0, 1023, 65536, 3128.5, "3128"]) assert.throws(() => parseToChild({ t: "start", v: 1, start: { ...start, network: { proxyPort: port } } }), ChannelError, String(port));
  // Only the port is carried: a field a forged start adds to the route is dropped, not passed on.
  assert.deepEqual((parseToChild({ t: "start", v: 1, start: { ...start, network: { proxyPort: 3128, host: "10.0.0.1" } } }) as { start: ChannelStart }).start.network, { proxyPort: 3128 });
  // A line that holds one largest piece fits the channel's line limit.
  assert.ok(encodeMessage({ t: "net.data", id: 1, data }).length < MAX_CHANNEL_LINE_BYTES);
});
