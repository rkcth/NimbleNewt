import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { fauxAssistantMessage, fauxToolCall, Type } from "@earendil-works/pi-ai";
import { MemoryStorage } from "@earendil-works/pi-durable";
import { requestId } from "@nimblenewt/contracts";
import { cleanJsonText, cleanPayload } from "./argument-clean.js";
import { shapeModels } from "./cache-shaping.js";
import { PiAdapter } from "./index.js";
import { rig, wireBody, type WireApi } from "./testing/wire.js";

// Card W01b: the production serialiser's gap. pi-ai 1.3.0 re-sends an earlier tool call's arguments with JSON.stringify and
// no surrogate cleaning, so arguments that decode to a lone surrogate (a model's `\ud800` without its other half) make the
// whole history invalid for a strict server. Offline: the bodies are those pi-ai builds, stopped before anything is sent.

const adapters: PiAdapter[] = [];
afterEach(async () => { for (const a of adapters.splice(0)) await a.close(); });

const LONE_HIGH = String.fromCharCode(0xd800);
const LONE_LOW = String.fromCharCode(0xdfff);
/** Is every string in the value well-formed Unicode? (keys too) */
const wellFormedDeep = (v: unknown): boolean => {
  if (typeof v === "string") return !/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/.test(v);
  if (Array.isArray(v)) return v.every(wellFormedDeep);
  if (v !== null && typeof v === "object") return Object.entries(v).every(([k, x]) => wellFormedDeep(k) && wellFormedDeep(x));
  return true;
};
/** What a strict server reads: the body as sent (JSON text), decoded, and every tool call's arguments text decoded too. */
function strictServerAccepts(body: unknown): boolean {
  const decoded = JSON.parse(JSON.stringify(body)) as Record<string, unknown>;
  if (!wellFormedDeep(decoded)) return false;
  const texts: string[] = [];
  for (const m of (decoded["messages"] ?? []) as { tool_calls?: { function: { arguments: string } }[] }[]) for (const t of m.tool_calls ?? []) texts.push(t.function.arguments);
  for (const i of (decoded["input"] ?? []) as { type?: string; arguments?: string }[]) if (i.type === "function_call" && typeof i.arguments === "string") texts.push(i.arguments);
  return texts.every((t) => { try { return wellFormedDeep(JSON.parse(t)); } catch { return false; } });
}
/** The arguments of the first earlier tool call in a body, decoded, whatever the API's shape. */
function firstCallArguments(api: WireApi, body: Record<string, unknown>): Record<string, unknown> {
  const decoded = JSON.parse(JSON.stringify(body)) as Record<string, unknown>;
  if (api === "openai-completions") { for (const m of decoded["messages"] as { tool_calls?: { function: { arguments: string } }[] }[]) if (m.tool_calls) return JSON.parse(m.tool_calls[0]!.function.arguments) as Record<string, unknown>; }
  if (api === "openai-responses") { for (const i of decoded["input"] as { type?: string; arguments?: string }[]) if (i.type === "function_call") return JSON.parse(i.arguments!) as Record<string, unknown>; }
  if (api === "anthropic-messages") { for (const m of decoded["messages"] as { content: unknown }[]) if (Array.isArray(m.content)) for (const b of m.content as { type: string; input?: Record<string, unknown> }[]) if (b.type === "tool_use") return b.input!; }
  throw new Error(`no tool call in the ${api} body`);
}

test("the cleaner: lone surrogates, escaped or raw, become U+FFFD; pairs, other escapes and every other byte stay; nothing to clean returns the same object", () => {
  assert.deepEqual(cleanJsonText('{"a":"\\ud800-\\udfff \\ud800\\udfff \\\\ud800"}'), { text: '{"a":"\\ufffd-\\ufffd \\ud800\\udfff \\\\ud800"}', replaced: 2 });
  assert.deepEqual(cleanJsonText(`{"a":"${LONE_LOW}😀"}`), { text: '{"a":"�😀"}', replaced: 1 });
  const same = { messages: [{ role: "assistant", tool_calls: [{ function: { arguments: '{"a":"\\ud83d\\ude00 \\u00e9"}' } }] }], text: "\\ud800 is text here" };
  const r = cleanPayload(same);
  assert.equal(r.payload, same);
  assert.equal(r.strings, 0);
  const lone = { messages: [{ role: "assistant", tool_calls: [{ function: { arguments: '{"a":"\\udc00"}' } }] }, { role: "user", content: `x${LONE_HIGH}` }] };
  const c = cleanPayload(lone);
  assert.deepEqual(c.payload, { messages: [{ role: "assistant", tool_calls: [{ function: { arguments: '{"a":"\\ufffd"}' } }] }, { role: "user", content: "x�" }] });
  assert.equal(c.strings, 2); assert.equal(c.arguments, 1);
  assert.equal(lone.messages[1]!.content, `x${LONE_HIGH}`, "not changed in place");
  const trap = new Proxy({}, { ownKeys() { throw new Error("boom"); }, getPrototypeOf() { return Object.prototype; } });
  assert.doesNotThrow(() => cleanPayload({ a: [trap] }));
});

const APIS: WireApi[] = ["openai-completions", "openai-responses", "anthropic-messages"];

for (const api of APIS) {
  test(`${api}: pinned pi-ai 1.3.0 alone re-sends tool-call arguments that decode to a lone surrogate (the gap), and through the adapter the next request is valid Unicode JSON with the pair kept`, async () => {
    // The model's tool call as pi-ai holds it after parsing the model's JSON: `\ud800` and `\udfff` apart decode to lone surrogates.
    const args = { text: `a${LONE_HIGH}-${LONE_LOW} 😀 \\ud800 written out` };
    const world = rig(api);
    const seenArgs: unknown[] = [];
    const adapter = await PiAdapter.open({
      storage: new MemoryStorage(), models: world.models, model: world.ref,
      tools: [{ name: "note", description: "keeps a note", parameters: Type.Object({ text: Type.String() }), execute: async (a) => { seenArgs.push(a); return "kept"; } }],
    });
    adapters.push(adapter);
    world.reply(fauxAssistantMessage(fauxToolCall("note", args, { id: "call_1" }), { stopReason: "toolUse" }), "done");
    await (await adapter.root().submit({ kind: "input", requestId: requestId("r1"), content: "keep a note" })).result();
    assert.equal(world.seen.length, 2);
    assert.deepEqual(seenArgs, [args], "the tool got the model's arguments as they were (the repair is only on the wire)");
    const second = world.seen[1]!;
    // The gap: the same request built by pi-ai 1.3.0 without the adapter's onPayload.
    const raw = await wireBody({ ...second, options: { ...(second.options ?? {}), onPayload: undefined } });
    assert.equal(strictServerAccepts(raw), false, "pi-ai alone sends arguments a strict server refuses");
    // Through the adapter (its onPayload, as the harness handed it to the provider).
    const body = await wireBody(second);
    assert.equal(strictServerAccepts(body), true);
    assert.deepEqual(firstCallArguments(api, body), { text: "a�-� 😀 \\ud800 written out" });
  });
}

test("a request with nothing to clean is built exactly as pi-ai builds it without the adapter's repair", async () => {
  for (const api of APIS) {
    const world = rig(api);
    const adapter = await PiAdapter.open({
      storage: new MemoryStorage(), models: world.models, model: world.ref,
      tools: [{ name: "note", description: "keeps a note", parameters: Type.Object({ text: Type.String() }), execute: async () => "kept" }],
    });
    adapters.push(adapter);
    world.reply(fauxAssistantMessage(fauxToolCall("note", { text: "plain 😀 é \\ud800" }, { id: "call_1" }), { stopReason: "toolUse" }), "done");
    await (await adapter.root().submit({ kind: "input", requestId: requestId("r1"), content: "keep a note" })).result();
    const second = world.seen[1]!;
    const raw = await wireBody({ ...second, options: { ...(second.options ?? {}), onPayload: undefined } });
    assert.equal(JSON.stringify(await wireBody(second)), JSON.stringify(raw), api);
  }
});

test("the cleaner, exact cases: a pair is kept however its halves are written; text that is not JSON is not read as escapes; keys are strings too; idempotent", () => {
  // JSON decodes an escaped half next to a raw half to the pair, so these need nothing.
  for (const s of [`{"a":"\\ud800${LONE_LOW}"}`, `{"a":"${LONE_HIGH}\\udfff"}`, '{"a":"\\uD800\\uDFFF"}']) assert.deepEqual(cleanJsonText(s), { text: s, replaced: 0 }, s);
  assert.deepEqual(cleanJsonText(`{"a":"\\ud800${LONE_HIGH}"}`), { text: '{"a":"\\ufffd�"}', replaced: 2 });
  // Not valid JSON: escapes are left as written, raw lone surrogates are replaced, nothing throws.
  for (const s of ['{"a":"\\ud800', "\\ud800 not json", '{"a":"\\ud800"} trailing']) assert.deepEqual(cleanJsonText(s), { text: s, replaced: 0 }, s);
  assert.deepEqual(cleanJsonText(`{"a":"\\ud800 ${LONE_LOW}`), { text: '{"a":"\\ud800 �', replaced: 1 });
  // An object key with a lone surrogate (Anthropic's `input` is an object): replaced, the key order and every value kept.
  const keyed = { messages: [{ role: "assistant", content: [{ type: "tool_use", id: "t", name: "n", input: { first: 1, [`k${LONE_HIGH}`]: "v", ["__proto__"]: "own", last: [2] } }] }] };
  Object.defineProperty(keyed.messages[0]!.content[0]!.input, "__proto__", { value: "own", enumerable: true, writable: true, configurable: true });
  const k = cleanPayload(keyed);
  const input = (k.payload as typeof keyed).messages[0]!.content[0]!.input as Record<string, unknown>;
  assert.deepEqual(Object.keys(input), ["first", "k�", "__proto__", "last"]);
  assert.equal(Object.getPrototypeOf(input), Object.prototype);
  assert.equal(input["__proto__"], "own");
  assert.equal(k.strings, 1);
  // Idempotent: a cleaned payload needs nothing more.
  const messy = { messages: [{ role: "assistant", tool_calls: [{ function: { arguments: '{"a":"\\ud800 \\udfff"}' } }] }, { role: "user", content: `x${LONE_LOW}` }] };
  const once = cleanPayload(messy);
  const twice = cleanPayload(once.payload);
  assert.equal(twice.payload, once.payload);
  assert.equal(twice.strings, 0);
});

test("the cleaner is linear on large text: a megabyte of arguments, of backslashes and of lone surrogates each stay within a generous time bound (linear, no backtracking)", () => {
  const cases = [
    `{"a":"${"x\\ud800\\udfff\\n".repeat(80_000)}\\ud800"}`,
    `{"a":"${"\\\\".repeat(500_000)}\\ud800"}`,
    `{"a":"${LONE_HIGH.repeat(1_000_000)}"}`,
  ];
  for (const s of cases) {
    const t0 = performance.now();
    const r = cleanPayload({ messages: [{ role: "assistant", tool_calls: [{ function: { arguments: s } }] }], other: s });
    assert.equal(r.arguments, 1);
    assert.ok(performance.now() - t0 < 3000, `${Math.round(performance.now() - t0)} ms`);
  }
});

test("shapeModels: the repair runs last on every model call, the compaction call included, after the shaping and the caller's own onPayload, whose result it cleans", async () => {
  const captured: Record<string, unknown>[] = [];
  const fake = { streamSimple: (_m: unknown, _c: unknown, o: Record<string, unknown>) => { captured.push(o); return { result: async () => "done" }; } };
  const model = { provider: "p", api: "openai-completions", id: "m" };
  const order: string[] = [];
  const shaped = shapeModels(fake as never, { policy: () => ({ payload: (b: unknown) => { order.push("shape"); return b; } }) });
  const lone = { messages: [{ role: "assistant", tool_calls: [{ function: { arguments: '{"a":"\\ud800"}' } }] }] };
  const callerSaw: unknown[] = [];
  const earlier = async (b: unknown): Promise<unknown> => { order.push("caller"); callerSaw.push(b); return undefined; };
  await (shaped.completeSimple as (m: unknown, c: unknown, o: unknown) => Promise<unknown>)(model, { messages: [] }, { onPayload: earlier });
  (shaped.streamSimple as (m: unknown, c: unknown, o: unknown) => unknown)(model, { messages: [] }, { onPayload: earlier });
  assert.equal(captured.length, 2);
  for (const o of captured) {
    const onPayload = o["onPayload"] as (p: unknown, m: unknown) => Promise<unknown>;
    const out = await onPayload(lone, model) as typeof lone;
    assert.equal(out.messages[0]!.tool_calls[0]!.function.arguments, '{"a":"\\ufffd"}');
    const clean = { messages: [{ role: "user", content: "fine" }] };
    assert.equal(await onPayload(clean, model), clean, "a body that needs nothing is the same object");
  }
  assert.deepEqual(order, ["caller", "caller", "shape", "caller", "shape", "caller"]);
  assert.equal(callerSaw.filter((b) => b === lone).length, 2, "the caller sees the body before the repair");
  // A caller that replaces the body: its replacement is what gets cleaned.
  captured.length = 0;
  (shaped.streamSimple as (m: unknown, c: unknown, o: unknown) => unknown)(model, { messages: [] }, { onPayload: async () => lone });
  const out = await (captured[0]!["onPayload"] as (p: unknown, m: unknown) => Promise<unknown>)({ messages: [] }, model) as typeof lone;
  assert.equal(out.messages[0]!.tool_calls[0]!.function.arguments, '{"a":"\\ufffd"}');
  // A caller's error still reaches pi-ai as before (the repair does not swallow the caller's own failure).
  captured.length = 0;
  (shaped.streamSimple as (m: unknown, c: unknown, o: unknown) => unknown)(model, { messages: [] }, { onPayload: async () => { throw new Error("caller failed"); } });
  await assert.rejects(() => (captured[0]!["onPayload"] as (p: unknown, m: unknown) => Promise<unknown>)({ messages: [] }, model), /caller failed/);
});
