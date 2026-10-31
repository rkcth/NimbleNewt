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
