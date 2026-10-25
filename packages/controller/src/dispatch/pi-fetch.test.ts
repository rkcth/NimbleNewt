import assert from "node:assert/strict";
import { test } from "node:test";
import { CacheEndpoints, type HttpRequest, type Transport } from "../inference-cache/index.js";
import { LlamaSim, VllmSim, simulatedFetch } from "../inference-cache/simulators.js";
import type { Principal } from "../security/principals.js";
import { CachePolicies } from "./cache.js";
import { responseBody } from "./pi-fetch.js";

// Card H12e: Pi's own HTTP calls go through the C06 CacheAdapter and the per-endpoint state. The tests send the body a provider SDK builds (a chat completion with `stream: true`) through the policy's fetch wrapper to the
// simulated servers of C06 and look at what the server saw and what the accounting would be told.

const principal = { id: "service:dispatcher", kind: "service", name: "dispatcher", grants: [] } as Principal;
const SECRET = "installation-secret-0123456789";
const A = "proj-aaaaaaaaaaaaaaaaaaaa", B = "proj-bbbbbbbbbbbbbbbbbbbb";
const URL_LLAMA = "http://127.0.0.1:8080";
const CHAT = `${URL_LLAMA}/v1/chat/completions`;
const config = (slots: number) => ({ "llama/local": { url: URL_LLAMA, config: { kind: "llama-cpp" as const, model: "local", route: "llama/local", options: { slots } } } });
const make = (slots: number, extra: Partial<ConstructorParameters<typeof CachePolicies>[0]> = {}) => new CachePolicies({ secret: SECRET, state: new CacheEndpoints(), principal, endpoints: config(slots), ...extra });
const chat = (turns: number, prefix = "shared project document ".repeat(60)) => ({ model: "local", stream: true, messages: [{ role: "system", content: prefix }, ...Array.from({ length: turns }, (_, i) => ({ role: i % 2 === 0 ? "user" : "assistant", content: `turn ${i}` }))] });
const post = (fetchFn: typeof globalThis.fetch, body: unknown, init: RequestInit = {}): Promise<Response> => fetchFn(CHAT, { method: "POST", headers: { authorization: "Bearer k", "content-type": "application/json" }, body: JSON.stringify(body), ...init });
const drain = async (response: Response): Promise<string> => response.text();
const ids = (seen: HttpRequest[]): unknown[] => seen.filter((r) => r.path === "/v1/chat/completions").map((r) => r.body["id_slot"]);

test("the same project reuses its slot between calls; the answer is streamed back to Pi and the backend's own hit figures are what accounting is told", async () => {
  const server = new LlamaSim(2); const seen: HttpRequest[] = [];
  const attempt = await make(2).forAttempt({ projectId: A, route: "llama/local" });
  const wrapped = attempt.policy.fetch!(simulatedFetch(server, seen));
  const first = await post(wrapped, chat(1));
  assert.match(first.headers.get("content-type") ?? "", /event-stream/);
  assert.match(await drain(first), /"timings"/);
  const second = await post(wrapped, chat(3));
  await drain(second);
  const calls = seen.filter((r) => r.path === "/v1/chat/completions");
  assert.deepEqual(calls.map((r) => [r.body["id_slot"], r.body["cache_prompt"]]), [[0, true], [0, true]]);
  assert.equal(calls[0]!.headers["authorization"], "Bearer k", "Pi's own credentials go to the server");
  assert.equal(seen.filter((r) => r.path.startsWith("/slots/")).length, 1, "the slot is cleared once, before the project's first call (its last holder was unknown)");
  const usage = (await attempt.takeUsage())!;
  assert.equal(usage.backend, "llama-cpp");
  assert.equal(usage.route, "llama/local");
  assert.ok(usage.cachedTokens > 0, "the second call read the first call's prompt from the slot");
  assert.ok(usage.computedTokens > 0);
  assert.equal(await attempt.takeUsage(), undefined, "taken once");
});

test("a project never reuses another project's prompt: separate slots when there are two, and a cleared slot or reuse off when there is only one", async () => {
  const policies = make(2); const server = new LlamaSim(2);
  const a = await policies.forAttempt({ projectId: A, route: "llama/local" });
  const b = await policies.forAttempt({ projectId: B, route: "llama/local" });
  const fa = a.policy.fetch!(simulatedFetch(server)); const fb = b.policy.fetch!(simulatedFetch(server));
  await drain(await post(fa, chat(3)));
  await drain(await post(fb, chat(3)));
  assert.equal((await b.takeUsage())!.cachedTokens, 0, "the same text in another project reads nothing");
  assert.ok(server.slots[0]!.length > 0 && server.slots[1]!.length > 0);
  await drain(await post(fa, chat(5)));
  assert.ok((await a.takeUsage())!.cachedTokens > 0, "its own slot still holds its prompt");

  // One slot, two projects: the second has none (refused), runs with reuse off and no slot, and the first finds its slot cleared on its next call.
  const one = make(1); const lone = new LlamaSim(1); const seen: HttpRequest[] = [];
  const x = await one.forAttempt({ projectId: A, route: "llama/local" });
  const y = await one.forAttempt({ projectId: B, route: "llama/local" });
  assert.equal(y.slot, undefined);
  const fx = x.policy.fetch!(simulatedFetch(lone, seen)); const fy = y.policy.fetch!(simulatedFetch(lone, seen));
  await drain(await post(fx, chat(3)));
  await drain(await post(fy, chat(3)));
  await drain(await post(fx, chat(5)));
  assert.deepEqual(seen.filter((r) => r.path === "/v1/chat/completions").map((r) => [r.body["id_slot"], r.body["cache_prompt"]]), [[0, true], [undefined, false], [0, true]]);
  assert.equal((await y.takeUsage())!.cachedTokens, 0);
  assert.equal((await x.takeUsage())!.cachedTokens, 0, "after the other project's call nothing is known about the slot: it is cleared, not reused");
  assert.equal(seen.filter((r) => r.path.startsWith("/slots/")).length, 2);
});

test("calls into one slot take turns, even when Pi has its answer before the stream has ended; calls into different slots run side by side", async () => {
  const policies = make(2);
  const a = await policies.forAttempt({ projectId: A, route: "llama/local" });
  const b = await policies.forAttempt({ projectId: B, route: "llama/local" });
  const open: string[] = []; const order: string[] = [];
  const closers: (() => void)[] = [];
  const gated = (tag: string): typeof globalThis.fetch => async (input, init) => {
    const path = new URL(String(input)).pathname;
    if (path !== "/v1/chat/completions") return new Response("{}", { status: 200, headers: { "content-type": "application/json" } });
    order.push(`start ${tag}`); open.push(tag);
    const encoder = new TextEncoder();
    let controller!: ReadableStreamDefaultController<Uint8Array>;
    const stream = new ReadableStream<Uint8Array>({ start: (c) => { controller = c; controller.enqueue(encoder.encode('data: {"choices":[{"delta":{"content":"hi"}}]}\n\n')); } });
    closers.push(() => { controller.enqueue(encoder.encode('data: {"choices":[],"usage":{"prompt_tokens":10},"timings":{"cache_n":4,"prompt_n":6}}\n\ndata: [DONE]\n\n')); controller.close(); order.push(`end ${tag}`); });
    void init;
    return new Response(stream, { status: 200, headers: { "content-type": "text/event-stream" } });
  };
  const tick = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));
  const fa = a.policy.fetch!(gated("a1")); const fa2 = a.policy.fetch!(gated("a2")); const fb = b.policy.fetch!(gated("b1"));
  const r1 = await post(fa, chat(1));
  assert.equal(r1.status, 200, "Pi has its answer while the stream is still open");
  const pending = post(fa2, chat(3));
  const other = post(fb, chat(1));
  await tick(); await tick(); await tick();
  assert.deepEqual(order, ["start a1", "start b1"], "the same slot's second call waits for the first stream to end; the other slot is not held up");
  await other;
  closers[0]!(); // the first stream ends
  await drain(r1);
  const r2 = await pending;
  assert.equal(r2.status, 200);
  assert.deepEqual(order, ["start a1", "start b1", "end a1", "start a2"]);
  closers[1]!(); closers[2]!();
  await drain(r2);
  assert.deepEqual(await a.takeUsage(), { backend: "llama-cpp", route: "llama/local", cachedTokens: 8, computedTokens: 12, writtenTokens: 0 }, "both calls' figures, summed");
});

test("a refused cache setting is repeated without cache settings and Pi gets the repeat's answer; a server error reaches Pi unchanged and records no hit", async () => {
  const policies = make(2);
  const refusing = new LlamaSim(2, { rejectSlot: true }); const seen: HttpRequest[] = [];
  const a = await policies.forAttempt({ projectId: A, route: "llama/local" });
  const response = await post(a.policy.fetch!(simulatedFetch(refusing, seen)), chat(1));
  assert.equal(response.status, 200);
  assert.match(await drain(response), /"timings"/);
  const chats = seen.filter((r) => r.path === "/v1/chat/completions");
  assert.deepEqual([chats.length, "id_slot" in chats[0]!.body, "id_slot" in chats[1]!.body], [2, true, false]);

  const broken: Transport = { send: async () => ({ status: 503, body: { error: { message: "no slots available" } } }) };
  const b = await make(2).forAttempt({ projectId: B, route: "llama/local" });
  const failed = await post(b.policy.fetch!(simulatedFetch(broken)), chat(1));
  assert.equal(failed.status, 503);
  assert.match(await drain(failed), /no slots available/);
  assert.equal(await b.takeUsage(), undefined);
});

test("an aborted call frees the slot's turn; requests that are not a JSON POST pass to the real fetch untouched", async () => {
  const a = await make(1).forAttempt({ projectId: A, route: "llama/local" });
  const server = new LlamaSim(1); const seen: HttpRequest[] = [];
  const wrapped = a.policy.fetch!(simulatedFetch(server, seen));
  const controller = new AbortController(); controller.abort();
  await assert.rejects(post(wrapped, chat(1), { signal: controller.signal }), /abort/i);
  await drain(await post(wrapped, chat(1)));
  assert.equal(seen.filter((r) => r.path === "/v1/chat/completions").length, 1, "the aborted call never reached the server and did not block the next one");
  const outside: string[] = [];
  const plain = a.policy.fetch!(async (input, init) => { outside.push(`${init?.method ?? "GET"} ${new URL(String(input)).pathname}`); return new Response("{}", { status: 200 }); });
  assert.equal((await plain(`${URL_LLAMA}/v1/models`, { method: "GET" })).status, 200);
  assert.deepEqual(outside, ["GET /v1/models"]);
  await assert.rejects(plain(CHAT, { method: "POST", body: "[1]" }), /not a JSON object/);
  assert.deepEqual(outside, ["GET /v1/models"], "a POST that is not a request object is not sent around the adapter");

  // Aborted while streaming: Pi's stream fails, the turn is released, and the next call to the slot goes ahead (the slot's holder was never recorded, so it is cleared first).
  const live = new AbortController(); const reached: string[] = [];
  const hanging: typeof globalThis.fetch = async (input, init) => {
    const path = new URL(String(input)).pathname;
    reached.push(path);
    if (path !== "/v1/chat/completions") return new Response("{}", { status: 200 });
    const stream = new ReadableStream<Uint8Array>({ start: (c) => { c.enqueue(new TextEncoder().encode('data: {"choices":[]}\n\n')); init?.signal?.addEventListener("abort", () => c.error(new DOMException("aborted", "AbortError"))); } });
    return new Response(stream, { status: 200, headers: { "content-type": "text/event-stream" } });
  };
  const hang = a.policy.fetch!(hanging);
  const streaming = await post(hang, chat(1), { signal: live.signal });
  live.abort();
  await assert.rejects(drain(streaming), /abort/i);
  const again = await post(a.policy.fetch!(simulatedFetch(server, seen)), chat(1));
  await drain(again);
  assert.equal(seen.filter((r) => r.path === "/v1/chat/completions").length, 2, "the next call reached the server");
});

test("without the endpoint's state the call is observed: sent as Pi built it, and the hit figures still reach accounting; other backends are observed too", async () => {
  const noState = await make(2, { state: undefined as never }).forAttempt({ projectId: A, route: "llama/local" });
  const server = new LlamaSim(2); const seen: HttpRequest[] = [];
  const wrapped = noState.policy.fetch!(simulatedFetch(server, seen));
  await drain(await post(wrapped, chat(1))); await drain(await post(wrapped, chat(3)));
  assert.deepEqual(seen.map((r) => r.path), ["/v1/chat/completions", "/v1/chat/completions"], "no slot is cleared or named");
  assert.equal(seen[0]!.body["id_slot"], undefined);
  assert.ok((await noState.takeUsage())!.cachedTokens >= 0);

  const policies = new CachePolicies({ secret: SECRET, state: new CacheEndpoints(), principal, endpoints: { "vllm/big": { url: "http://127.0.0.1:8000", config: { kind: "vllm", model: "big", route: "vllm/big", options: { promptDetails: true } } } } });
  const v = await policies.forAttempt({ projectId: A, route: "vllm/big" });
  assert.equal(v.routed, false);
  const vsim = new VllmSim(); const vf = v.policy.fetch!(simulatedFetch(vsim));
  const send = (turns: number) => vf("http://127.0.0.1:8000/v1/chat/completions", { method: "POST", body: JSON.stringify(v.policy.payload(chat(turns))) }).then(drain);
  await send(2); await send(4);
  const usage = (await v.takeUsage())!;
  assert.equal(usage.backend, "vllm");
  assert.ok(usage.cachedTokens > 0);
  // A route with no configured endpoint is left to Pi: no wrapper.
  assert.equal((await policies.forAttempt({ projectId: A, route: "other/model" })).policy.fetch, undefined);
});

test("the answer is read from server-sent events or a plain body, whatever order the figures arrive in", () => {
  const sse = 'data: {"choices":[{"delta":{"content":"a"}}]}\n\ndata: {"choices":[],"usage":{"prompt_tokens":9},"timings":{"cache_n":3,"prompt_n":6}}\n\ndata: [DONE]\n\n';
  assert.deepEqual(responseBody(sse, true), { usage: { prompt_tokens: 9 }, timings: { cache_n: 3, prompt_n: 6 } });
  const claude = 'event: message_start\ndata: {"type":"message_start","message":{"usage":{"input_tokens":5,"cache_read_input_tokens":40}}}\n\nevent: message_delta\ndata: {"type":"message_delta","usage":{"output_tokens":7}}\n\n';
  assert.deepEqual(responseBody(claude, true), { usage: { input_tokens: 5, cache_read_input_tokens: 40, output_tokens: 7 } });
  assert.deepEqual(responseBody('{"usage":{"a":1}}', false), { usage: { a: 1 } });
  assert.equal(responseBody("<html>", false), undefined);
});

test("a request that skips the usual shape still goes through the adapter (a Request object, bytes, a stream, a blob) or is refused; it is never sent around it", async () => {
  const a = await make(2).forAttempt({ projectId: A, route: "llama/local" });
  const server = new LlamaSim(2); const seen: HttpRequest[] = [];
  const wrapped = a.policy.fetch!(simulatedFetch(server, seen));
  const json = JSON.stringify(chat(1));
  const sent = () => seen.filter((r) => r.path === "/v1/chat/completions");
  await drain(await wrapped(new Request(CHAT, { method: "POST", body: json, headers: { authorization: "Bearer r" } })));
  await drain(await wrapped(CHAT, { method: "POST", body: new TextEncoder().encode(json) }));
  await drain(await wrapped(CHAT, { method: "post", body: new ReadableStream({ start: (c) => { c.enqueue(new TextEncoder().encode(json)); c.close(); } }), duplex: "half" } as RequestInit));
  await drain(await wrapped(new URL(CHAT), { method: "POST", body: new Blob([json]) }));
  assert.equal(sent().length, 4);
  for (const r of sent()) assert.deepEqual([r.body["id_slot"], r.body["cache_prompt"]], [0, true], "each went through the adapter: a slot named, reuse on");
  assert.equal(sent()[0]!.headers["authorization"], "Bearer r", "a Request's headers are kept");
  // Not readable as a JSON object: refused, nothing reaches the server.
  for (const init of [{ method: "POST", body: "not json" }, { method: "POST", body: new URLSearchParams({ a: "b" }) }, { method: "POST" }] as RequestInit[]) {
    await assert.rejects(wrapped(CHAT, init), /not a JSON object/);
  }
  assert.equal(sent().length, 4);
});

test("the slot's turn ends with the provider's end marker even when the connection stays open, and when Pi leaves its stream; an abort while queued is answered at once", async () => {
  const policies = make(1);
  const a = await policies.forAttempt({ projectId: A, route: "llama/local" });
  const encoder = new TextEncoder();
  const opened: AbortSignal[] = []; let sources = 0;
  const marker = (tail: string): typeof globalThis.fetch => async (input, init) => {
    if (new URL(String(input)).pathname !== "/v1/chat/completions") return new Response("{}", { status: 200 });
    sources++; if (init?.signal) opened.push(init.signal);
    // A stream that sends its answer and the marker and then stays open for ever, as a proxy holding the connection would.
    return new Response(new ReadableStream({ start: (c) => { c.enqueue(encoder.encode(`data: {"choices":[{"delta":{"content":"x"}}]}\n\n${tail}`)); } }), { status: 200, headers: { "content-type": "text/event-stream" } });
  };
  const timings = 'data: {"choices":[],"usage":{"prompt_tokens":10},"timings":{"cache_n":4,"prompt_n":6}}\n\ndata: [DONE]\n\n';
  const f = a.policy.fetch!(marker(timings));
  // Pi reads to the marker and never reads further or cancels; the next call must still get the turn at once.
  const first = await post(f, chat(1));
  const second = post(f, chat(3));
  const r2 = await second;
  assert.equal(r2.status, 200);
  assert.match(await drain(first), /\[DONE\]/, "Pi still receives everything up to and including the marker");
  assert.equal(sources, 2);
  assert.deepEqual(await a.takeUsage(), { backend: "llama-cpp", route: "llama/local", cachedTokens: 8, computedTokens: 12, writtenTokens: 0 });
  assert.ok(opened.every((s) => s.aborted), "the connections were dropped at the marker");
  // Anthropic's end marker ends a turn the same way.
  const claude = a.policy.fetch!(marker('event: message_stop\ndata: {"type":"message_stop"}\n\n'));
  await drain(await post(claude, chat(1)));
  assert.equal(sources, 3);
  // Pi cancels mid-generation without any abort signal of its own: the request to the server is aborted and the turn is released.
  const hangs = a.policy.fetch!(marker(""));
  const leaving = await post(hangs, chat(1));
  const waiting = post(f, chat(3));
  await leaving.body!.cancel();
  assert.equal((await waiting).status, 200);
  assert.equal(opened.at(-2)!.aborted, true, "the server was told to stop");
  // A caller that aborts while it waits for the turn is answered at once and its call is never sent.
  const holder = await post(a.policy.fetch!(marker("")), chat(1));
  const queued = new AbortController();
  const queuedCall = post(f, chat(3), { signal: queued.signal });
  const before = sources;
  queued.abort();
  await assert.rejects(queuedCall, /abort/i);
  await holder.body!.cancel();
  await (await post(f, chat(3))).text();
  assert.equal(sources, before + 1, "the aborted call was not sent; the one after it was");
});

test("the end of an answer is a whole end event, not the words in the model's text: marker text inside content does not end the stream, and a marker split across chunks reaches Pi whole", async () => {
  const a = await make(1).forAttempt({ projectId: A, route: "llama/local" });
  const encoder = new TextEncoder();
  const serve = (chunks: string[]): typeof globalThis.fetch => async (input) => new URL(String(input)).pathname !== "/v1/chat/completions" ? new Response("{}", { status: 200 }) : new Response(new ReadableStream({ start: (c) => { for (const chunk of chunks) c.enqueue(encoder.encode(chunk)); } }), { status: 200, headers: { "content-type": "text/event-stream" } });
  const event = (o: unknown): string => `data: ${JSON.stringify(o)}\n\n`;
  const read = async (r: Response, until: string): Promise<string> => { const reader = r.body!.getReader(); let text = ""; while (!text.includes(until)) { const { done, value } = await reader.read(); if (done) break; text += new TextDecoder().decode(value); } return text; };
  // (a) an answer that talks about the marker
  const talk = serve([event({ choices: [{ delta: { content: "An SSE stream ends with data: [DONE] and then" } }] }), event({ choices: [{ delta: { content: " MORE CONTENT" } }] }), event({ choices: [], usage: { prompt_tokens: 10 }, timings: { cache_n: 4, prompt_n: 6 } }), "data: [DONE]\n\n"]);
  const first = await post(a.policy.fetch!(talk), chat(1));
  const seen = await read(first, "[DONE]\n\n");
  assert.match(seen, /MORE CONTENT/);
  assert.ok(seen.endsWith("data: [DONE]\n\n"));
  assert.deepEqual(await a.takeUsage(), { backend: "llama-cpp", route: "llama/local", cachedTokens: 4, computedTokens: 6, writtenTokens: 0 });
  // (b) markers split across chunks: Pi gets the whole final event, and the turn is released at it
  const split = serve([event({ choices: [{ delta: { content: "x" } }] }), "data: [DO", "NE]", "\n\n"]);
  assert.ok((await read(await post(a.policy.fetch!(split), chat(1)), "[DONE]\n\n")).endsWith("data: [DONE]\n\n"));
  const stop = serve(['data: {"type":"message_stop"', '}\n', '\n']);
  assert.ok((await read(await post(a.policy.fetch!(stop), chat(1)), '"message_stop"}\n\n')).endsWith('{"type":"message_stop"}\n\n'));
  // The turn was released each time: another call into the slot goes ahead.
  assert.equal((await post(a.policy.fetch!(serve([event({ choices: [] }), "data: [DONE]\n\n"])), chat(1))).status, 200);
});
