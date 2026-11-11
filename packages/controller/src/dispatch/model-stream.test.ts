import assert from "node:assert/strict";
import { test } from "node:test";
import { ModelStreamDecoder, type ModelStreamEvent } from "./model-stream.js";

const run = (bytes: Uint8Array, size: number): ModelStreamEvent[] => {
  const d = new ModelStreamDecoder();
  const out: ModelStreamEvent[] = [];
  for (let at = 0; at < bytes.length; at += size) out.push(...d.push(bytes.subarray(at, at + size)));
  out.push(...d.finish());
  return out;
};
const enc = new TextEncoder();
const data = (o: unknown): string => `data: ${JSON.stringify(o)}\n\n`;

test("the same events come out however the network cuts the bytes, including inside a multi-byte character", () => {
  const reply = enc.encode(data({ choices: [{ delta: { content: "Gärtner 🌱" }, finish_reason: null }] }) + data({ choices: [{ delta: { tool_calls: [{ index: 0, id: "c1", function: { name: "t", arguments: "{\"a\":" } }] } }] })
    + data({ choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: "1}" } }] } }] }) + data({ choices: [{ delta: {}, finish_reason: "tool_calls" }] }) + "data: [DONE]\r\n\r\n");
  const whole = run(reply, reply.length);
  const text = (events: ModelStreamEvent[]): string => events.filter((e) => e.kind === "text").map((e) => (e as { text: string }).text).join("");
  for (const size of [1, 2, 3, 7, 50]) {
    const events = run(reply, size);
    // A character cut by the network arrives whole in a later event: the text is the same, and no event holds a broken character.
    assert.equal(text(events), "Gärtner 🌱", `size ${size}`);
    assert.ok(!text(events).includes("�"));
    assert.deepEqual(events.filter((e) => e.kind !== "text"), whole.filter((e) => e.kind !== "text"));
  }
  assert.deepEqual(whole.filter((e) => e.kind !== "text"), [
    { kind: "tool", id: "c1", name: "t", argumentsDelta: "{\"a\":", done: false },
    { kind: "tool", id: "c1", argumentsDelta: "1}", done: false },
    { kind: "tool", id: "c1", argumentsDelta: "", done: true },
    { kind: "end" },
  ]);
});

test("a stream that ends without saying so yields no end event and no done tool call (its tool call stays partial), and junk is ignored", () => {
  const events = run(enc.encode(": keep-alive\n\nevent: ping\ndata: not json\n\n" + data({ choices: [{ delta: { tool_calls: [{ index: 0, id: "c2", function: { name: "w", arguments: "{\"x" } }] } }] })), 5);
  assert.deepEqual(events, [{ kind: "tool", id: "c2", name: "w", argumentsDelta: "{\"x", done: false }]);
});

test("a reply that is not understood yields nothing", () => {
  assert.deepEqual(run(enc.encode("<html>bad gateway</html>"), 4), []);
  assert.deepEqual(run(enc.encode(JSON.stringify({ unrelated: true })), 4), []);
});

test("an id the generation service would refuse is replaced by a safe one", () => {
  const events = run(enc.encode(data({ choices: [{ delta: { tool_calls: [{ index: 3, id: "has spaces and ☃", function: { name: "t", arguments: "{}" } }] } }] })), 100);
  assert.equal((events[0] as { id: string }).id, "call-3");
});

test("null elements in a reply do not throw: tool_calls [null], content [null], choices [null]", () => {
  const sseOf = (o: unknown): Uint8Array => enc.encode(data(o));
  assert.doesNotThrow(() => run(sseOf({ choices: [{ delta: { tool_calls: [null] } }] }), 1000));
  assert.doesNotThrow(() => run(sseOf({ choices: [null] }), 1000));
  assert.doesNotThrow(() => run(sseOf({ type: "content_block_start", index: 0, content_block: null }), 1000));
  assert.doesNotThrow(() => run(enc.encode(JSON.stringify({ choices: [{ message: { tool_calls: [null], content: "x" } }] })), 1000));
  assert.doesNotThrow(() => run(enc.encode(JSON.stringify({ content: [null, { type: "text", text: "x" }] })), 1000));
  assert.equal(run(enc.encode(JSON.stringify({ content: [null, { type: "text", text: "x" }] })), 1000).some((e) => e.kind === "text"), true);
});

test("an event's data may span several lines; a comment line shows a stream; only the first choice is recorded; a line over 1 MB is noted", () => {
  const spread = enc.encode(`data: {"choices":[{"delta":\ndata: {"content":"hi"}}]}\n\n`);
  assert.deepEqual(run(spread, 1000).filter((e) => e.kind === "text"), [{ kind: "text", text: "hi" }]);
  const d = new ModelStreamDecoder();
  d.push(enc.encode(": keep-alive\n\n"));
  assert.equal(d.streaming, true);
  assert.deepEqual(run(enc.encode(data({ choices: [{ index: 1, delta: { content: "second" } }, { index: 0, delta: { content: "first" } }] })), 1000).filter((e) => e.kind !== "end"), [{ kind: "note", text: "choice 1 of the reply is not recorded (only the first choice is)" }, { kind: "text", text: "first" }]);
  const long = enc.encode(`data: ${"x".repeat(1024 * 1024 + 10)}`);
  assert.ok(run(long, 200_000).some((e) => e.kind === "note" && /longer than 1 MB/.test(e.text)));
});

test("a provider ID the recorder cannot keep is recorded under a safe one with the ID the tool bridge will send as its alias; a safe ID has none (card L05d)", async () => {
  const { bridgeCallIdOf } = await import("./model-stream.js");
  const { createHash } = await import("node:crypto");
  const raw = "has spaces and ☃";
  const hashed = `h:${createHash("sha256").update(raw).digest("hex").slice(0, 40)}`;
  assert.equal(bridgeCallIdOf(raw), hashed);
  assert.equal(bridgeCallIdOf("call_1"), "call_1");
  const long = "x".repeat(100);
  assert.equal(bridgeCallIdOf(long), long, "up to 120 characters the extension sends the ID as it is");
  assert.equal(bridgeCallIdOf("y".repeat(121)).startsWith("h:"), true);
  // OpenAI style streamed: the alias comes with the first piece only.
  const streamed = run(enc.encode(data({ choices: [{ delta: { tool_calls: [{ index: 3, id: raw, function: { name: "t", arguments: "{" } }] } }] }) + data({ choices: [{ delta: { tool_calls: [{ index: 3, function: { arguments: "}" } }] } }] }) + data({ choices: [{ delta: {}, finish_reason: "tool_calls" }] })), 100).filter((e) => e.kind === "tool");
  assert.deepEqual(streamed[0], { kind: "tool", id: "call-3", name: "t", alias: hashed, argumentsDelta: "{", done: false });
  assert.equal((streamed[1] as { alias?: string }).alias, undefined);
  // An ID of 100 characters is too long to record but is sent as it is.
  const longOne = run(enc.encode(data({ choices: [{ delta: { tool_calls: [{ index: 0, id: long, function: { name: "t", arguments: "{}" } }] } }] })), 100)[0] as { id: string; alias?: string };
  assert.deepEqual([longOne.id, longOne.alias], ["call-0", long]);
  // A safe ID has no alias, in any of the four reply shapes.
  const safe = [
    run(enc.encode(data({ choices: [{ delta: { tool_calls: [{ index: 0, id: "ok_1", function: { name: "t", arguments: "{}" } }] } }] })), 100),
    run(enc.encode(JSON.stringify({ choices: [{ message: { tool_calls: [{ id: "ok_1", function: { name: "t", arguments: "{}" } }] } }] })), 1000),
    run(enc.encode(data({ type: "content_block_start", index: 0, content_block: { type: "tool_use", id: "ok_1", name: "t" } })), 100),
    run(enc.encode(JSON.stringify({ content: [{ type: "tool_use", id: "ok_1", name: "t", input: {} }] })), 1000),
  ];
  for (const events of safe) assert.equal((events.find((e) => e.kind === "tool") as { alias?: string }).alias, undefined);
  // Whole replies and Anthropic style carry the alias too.
  const whole = run(enc.encode(JSON.stringify({ choices: [{ message: { tool_calls: [{ id: raw, function: { name: "t", arguments: "{}" } }] } }] })), 1000).find((e) => e.kind === "tool") as { id: string; alias?: string };
  assert.deepEqual([whole.id, whole.alias], ["call-0", hashed]);
  const anthropic = run(enc.encode(data({ type: "content_block_start", index: 2, content_block: { type: "tool_use", id: raw, name: "t" } })), 100).find((e) => e.kind === "tool") as { id: string; alias?: string };
  assert.deepEqual([anthropic.id, anthropic.alias], ["call-2", hashed]);
  const anthropicWhole = run(enc.encode(JSON.stringify({ content: [{ type: "tool_use", id: raw, name: "t", input: {} }] })), 1000).find((e) => e.kind === "tool") as { id: string; alias?: string };
  assert.deepEqual([anthropicWhole.id, anthropicWhole.alias], ["call-0", hashed]);
});
