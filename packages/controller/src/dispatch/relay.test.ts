import assert from "node:assert/strict";
import { test } from "node:test";
import { ModelRelay, type RelayRequest } from "./relay.js";

interface Seen { url: string; method: string; headers: Record<string, string>; body: string | undefined }
function setup(options: { respond?: () => Response } = {}) {
  const calls: Seen[] = [];
  let key = "sk-first";
  const fetch: typeof globalThis.fetch = async (input, init) => {
    calls.push({ url: String(input), method: init?.method ?? "GET", headers: Object.fromEntries(new Headers(init?.headers).entries()), body: init?.body === undefined ? undefined : Buffer.from(init.body as Buffer).toString("utf8") });
    return options.respond?.() ?? new Response(new ReadableStream({ start(c) { c.enqueue(new TextEncoder().encode("data: a\n\n")); c.enqueue(new TextEncoder().encode("data: b\n\n")); c.close(); } }), { status: 200, headers: { "content-type": "text/event-stream", "set-cookie": "x=1", "x-secret": "no", "retry-after": "1" } });
  };
  const relay = new ModelRelay({ endpoint: (route) => (route === "llama/local" ? { url: "http://llama.internal:8080/v1/", headers: () => ({ authorization: `Bearer ${key}` }) } : undefined), fetch });
  return { calls, relay, rotate: (k: string) => { key = k; } };
}
const req = (url: string, extra: Partial<RelayRequest> = {}): RelayRequest => ({ url, method: "POST", headers: [["content-type", "application/json"]], body: Buffer.from(JSON.stringify({ model: "local" })), signal: new AbortController().signal, ...extra });
const text = async (body: AsyncIterable<Uint8Array> | null): Promise<string> => { let s = ""; for await (const c of body ?? []) s += Buffer.from(c).toString("utf8"); return s; };

test("a call goes to the route's endpoint with the provider's credential, which the process never supplies, and the reply streams back", async () => {
  const { calls, relay, rotate } = setup();
  const attempt = relay.forAttempt({ route: "llama/local" });
  assert.equal(attempt.alias, "m0");
  const response = await attempt.relay(req("http://relay.invalid/m0/chat/completions", { headers: [["content-type", "application/json"], ["authorization", "Bearer from-the-process"], ["x-api-key", "k"], ["cookie", "c=1"], ["host", "evil"], ["x-stainless-os", "linux"], ["user-agent", "OpenAI/JS"]] }));
  assert.equal(response.status, 200);
  assert.equal(await text(response.body), "data: a\n\ndata: b\n\n");
  assert.deepEqual(calls[0], { url: "http://llama.internal:8080/v1/chat/completions", method: "POST", headers: { "content-type": "application/json", authorization: "Bearer sk-first", "user-agent": "OpenAI/JS" }, body: JSON.stringify({ model: "local" }) });
  assert.deepEqual(response.headers.map(([k]) => k).sort(), ["content-type", "retry-after"], "only the headers a client needs come back; no cookies or server internals");
  rotate("sk-second");
  await attempt.relay(req("http://relay.invalid/m0/messages"));
  assert.equal(calls[1]!.headers["authorization"], "Bearer sk-second", "a rotated credential is used from the next call");
  assert.equal(calls[1]!.url, "http://llama.internal:8080/v1/messages");
});

test("an address that is not the attempt's own is refused before anything is sent", async () => {
  const { calls, relay } = setup();
  const attempt = relay.forAttempt({ route: "llama/local" });
  const refused = ["http://relay.invalid/m1/x", "http://relay.invalid/x", "http://relay.invalid.evil.example/m0/x", "https://relay.invalid/m0/chat/completions", "http://169.254.169.254/latest", "http://relay.invalid/m0/../admin", "http://relay.invalid/m0/a/../b",
    "http://relay.invalid/m0/%2e%2e/x", "http://relay.invalid/m0/a%2fb", "http://relay.invalid/m0//x", "http://relay.invalid/m0/", "http://u:p@relay.invalid/m0/chat/completions", "http://relay.invalid/m0/x#frag", `http://relay.invalid/m0/${"a".repeat(3000)}`];
  for (const url of refused) await assert.rejects(attempt.relay(req(url)), /refused the call/, url.slice(0, 80));
  for (const method of ["GET", "PUT", "DELETE", "CONNECT", "PATCH"]) await assert.rejects(attempt.relay(req("http://relay.invalid/m0/chat/completions", { method })), /method/);
  await assert.rejects(attempt.relay(req("http://relay.invalid/m0/chat/completions", { body: Buffer.alloc(9 * 1024 * 1024) })), /too large/);
  // Only the model API's own calls: no files, batches, fine-tuning, query strings, another model in the body.
  for (const url of ["http://relay.invalid/m0/files", "http://relay.invalid/m0/batches", "http://relay.invalid/m0/fine_tuning/jobs", "http://relay.invalid/m0/chat/completions?x=1", "http://relay.invalid/m0/models"]) await assert.rejects(attempt.relay(req(url)), /refused the call/, url);
  const pinned = relay.forAttempt({ route: "llama/local", model: "local" });
  await assert.rejects(pinned.relay(req("http://relay.invalid/m0/chat/completions", { body: Buffer.from(JSON.stringify({ model: "expensive" })) })), /another model/);
  await assert.rejects(pinned.relay(req("http://relay.invalid/m0/chat/completions", { body: Buffer.from("nope") })), /not JSON/);
  await pinned.relay(req("http://relay.invalid/m0/chat/completions"));
  assert.equal(calls.length, 1);
  await attempt.relay(req("http://relay.invalid/m0/chat/completions", { headers: [["content-type", "application/json"], ["anthropic-beta", "files-api-2025"], ["openai-beta", "x"]] }));
  assert.deepEqual(Object.keys(calls[1]!.headers).sort(), ["authorization", "content-type"], "beta flags are not passed on");
});

test("a route with no endpoint reaches nothing, and a failing endpoint gives the process a redacted reason", async () => {
  const { calls, relay } = setup();
  await assert.rejects(relay.forAttempt({ route: "other/model" }).relay(req("http://relay.invalid/m0/chat/completions")), /has no endpoint/);
  assert.equal(calls.length, 0);
  const told: string[] = [];
  const failing = new ModelRelay({ endpoint: () => ({ url: "http://llama.internal/v1" }), fetch: async () => { throw new Error("connect ECONNREFUSED sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123456789"); }, onError: (_r, m) => told.push(m) });
  await assert.rejects(failing.forAttempt({ route: "x/y" }).relay(req("http://relay.invalid/m0/chat/completions")), (e: Error) => /could not be reached: connect ECONNREFUSED/.test(e.message) && !e.message.includes("abcdefghijklmnop"));
  assert.equal(told.length, 1);
});

test("the attempt's cache policy is applied around the call: the body edit and the endpoint's wrapper", async () => {
  const { calls, relay } = setup();
  const wrapped: string[] = [];
  const attempt = relay.forAttempt({ route: "llama/local" }, {
    payload: (body) => ({ ...(body as object), prompt_cache_key: "share-key", id_slot: 2 }),
    fetch: (inner) => async (input, init) => { wrapped.push(String(input)); return inner(input, init); },
  });
  await attempt.relay(req("http://relay.invalid/m0/chat/completions"));
  assert.deepEqual(JSON.parse(calls[0]!.body!), { model: "local", prompt_cache_key: "share-key", id_slot: 2 });
  assert.deepEqual(wrapped, ["http://llama.internal:8080/v1/chat/completions"]);
  // A body that is not JSON is sent as it is, and the wrapper still sees the call.
  await attempt.relay(req("http://relay.invalid/m0/chat/completions", { headers: [["content-type", "application/octet-stream"]], body: Buffer.from("raw") }));
  assert.equal(calls[1]!.body, "raw");
  assert.equal(wrapped.length, 2);
});

test("an aborted call reaches the endpoint's fetch as an abort", async () => {
  const seen: AbortSignal[] = [];
  const relay = new ModelRelay({ endpoint: () => ({ url: "http://llama.internal/v1" }), fetch: async (_i, init) => { seen.push(init!.signal!); return new Response("ok"); } });
  const controller = new AbortController();
  await relay.forAttempt({ route: "x/y" }).relay(req("http://relay.invalid/m0/chat/completions", { signal: controller.signal }));
  controller.abort();
  assert.equal(seen[0]!.aborted, true);
});

test("the provider's count of the first call's input is reported once, whichever style the reply has, and the reply is passed on unchanged", async () => {
  const stream = (chunks: string[]): Response => new Response(new ReadableStream({ start(c) { for (const s of chunks) c.enqueue(new TextEncoder().encode(s)); c.close(); } }), { status: 200, headers: { "content-type": "text/event-stream" } });
  const cases: [string, () => Response, number | undefined][] = [
    ["an OpenAI-style plain reply", () => new Response(JSON.stringify({ choices: [], usage: { prompt_tokens: 1234, completion_tokens: 5 } }), { status: 200, headers: { "content-type": "application/json" } }), 1234],
    ["an OpenAI-style stream that reports at its end", () => stream(["data: {\"choices\":[]}\n\n", "x".repeat(40_000), "data: {\"usage\":{\"prompt_tokens\":777}}\n\n", "data: [DONE]\n\n"]), 777],
    ["an Anthropic-style stream that reports at its start", () => stream(["event: message_start\ndata: {\"message\":{\"usage\":{\"input_tokens\":4321}}}\n\n", "y".repeat(40_000)]), 4321],
    ["a reply with no count", () => stream(["data: a\n\n"]), undefined],
  ];
  for (const [name, respond, expected] of cases) {
    const { relay } = setup({ respond });
    const told: { inputTokens: number; requestChars: number }[] = [];
    const attempt = relay.forAttempt({ route: "llama/local", onFirstUsage: (u) => { told.push(u); } });
    const first = await text((await attempt.relay(req("http://relay.invalid/m0/chat/completions"))).body);
    assert.deepEqual(told.map((t) => t.inputTokens), expected === undefined ? [] : [expected], name);
    if (expected !== undefined) assert.ok(told[0]!.requestChars > 0);
    const expectedBody = await text(respond().body);
    assert.equal(first, expectedBody, `${name}: unchanged`);
    await text((await attempt.relay(req("http://relay.invalid/m0/chat/completions"))).body);
    assert.ok(told.length <= 1, `${name}: only the first call is reported`);
  }
  // A reporter that throws, and a failed call, leave the call alone.
  const { relay } = setup({ respond: () => new Response("{\"usage\":{\"prompt_tokens\":9}}", { status: 200 }) });
  const attempt = relay.forAttempt({ route: "llama/local", onFirstUsage: () => { throw new Error("boom"); } });
  assert.match(await text((await attempt.relay(req("http://relay.invalid/m0/chat/completions"))).body), /prompt_tokens/);
  const failing = setup({ respond: () => new Response("{\"usage\":{\"prompt_tokens\":9}}", { status: 500 }) });
  const told: number[] = [];
  const bad = failing.relay.forAttempt({ route: "llama/local", onFirstUsage: (u) => { told.push(u.inputTokens); } });
  await text((await bad.relay(req("http://relay.invalid/m0/chat/completions"))).body);
  assert.deepEqual(told, [], "a failed call is not a measurement");
});

test("the count is not taken from a token-count probe, a cancelled reply or a number cut by the edge; a cache-aware count adds the cached tokens", async () => {
  const run = async (respond: () => Response, path = "chat/completions", cancelAfter?: number): Promise<number[]> => {
    const { relay } = setup({ respond });
    const told: number[] = [];
    const attempt = relay.forAttempt({ route: "llama/local", onFirstUsage: (u) => { told.push(u.inputTokens); } });
    const res = await attempt.relay(req(`http://relay.invalid/m0/${path}`));
    let n = 0;
    for await (const _ of res.body ?? []) { if (cancelAfter !== undefined && ++n >= cancelAfter) break; }
    return told;
  };
  const json = (o: unknown): Response => new Response(JSON.stringify(o), { status: 200, headers: { "content-type": "application/json" } });
  const sse = (chunks: string[]): Response => new Response(new ReadableStream({ start(c) { for (const x of chunks) c.enqueue(new TextEncoder().encode(x)); c.close(); } }), { status: 200 });
  assert.deepEqual(await run(() => json({ input_tokens: 55 }), "messages/count_tokens"), [], "a probe is not the call");
  assert.deepEqual(await run(() => json({ usage: { input_tokens: 10, cache_read_input_tokens: 4000, cache_creation_input_tokens: 200 } }), "messages"), [4210]);
  assert.deepEqual(await run(() => sse(["data: a\n\n", "data: b\n\n", "data: {\"prompt_tokens\":777}\n\n"]), "chat/completions", 1), [], "cancelled before the end");
  assert.deepEqual(await run(() => new Response("{\"usage\":{\"prompt_tokens\":12", { status: 200 })), [], "a number cut off is not a number");
});

test("the monitor is told when a call starts, when its first bytes arrive, at a bounded interval how much has come, and how it ended with the counts; probes, failures and a cancelled reply are told apart (card V01b)", async () => {
  const sse = (chunks: string[]): Response => new Response(new ReadableStream({ async start(c) { for (const x of chunks) { c.enqueue(new TextEncoder().encode(x)); await new Promise((r) => setTimeout(r, 15)); } c.close(); } }), { status: 200 });
  const watch = async (respond: () => Response, path = "chat/completions", opts: { progressMs?: number; cancelAfter?: number } = {}): Promise<string[]> => {
    const { relay } = setup({ respond });
    const told: string[] = [];
    const attempt = relay.forAttempt({ route: "llama/local", progressMs: opts.progressMs ?? 1_000_000, monitor: {
      started: (c) => { told.push(`started:${c.requestChars > 0}`); }, firstOutput: () => { told.push("first"); }, progress: (b) => { told.push(`progress:${b > 0}`); },
      finished: (c) => { told.push(`finished:${c.ok}:${c.inputTokens ?? "-"}:${c.cachedTokens ?? "-"}:${c.outputTokens ?? "-"}`); },
    } });
    const res = await attempt.relay(req(`http://relay.invalid/m0/${path}`));
    let n = 0;
    for await (const _ of res.body ?? []) { if (opts.cancelAfter !== undefined && ++n >= opts.cancelAfter) break; }
    return told;
  };
  const usage = "data: {\"usage\":{\"prompt_tokens\":900,\"completion_tokens\":40,\"prompt_tokens_details\":{\"cached_tokens\":300}}}\n\n";
  // A normal stream: start, first bytes once, no progress inside the interval, the end with what the provider reported.
  assert.deepEqual(await watch(() => sse(["data: a\n\n", "data: b\n\n", usage])), ["started:true", "first", "finished:true:900:300:40"]);
  // With a short interval progress is told, not more often than the interval allows.
  const slow = await watch(() => sse(["data: a\n\n", "data: b\n\n", "data: c\n\n", "data: d\n\n", usage]), "chat/completions", { progressMs: 20 });
  assert.equal(slow[0], "started:true"); assert.equal(slow[1], "first");
  const progress = slow.filter((x) => x === "progress:true").length;
  assert.ok(progress >= 1 && progress <= 3, `${progress} progress reports for about 60 ms at 20 ms`);
  assert.equal(slow.at(-1), "finished:true:900:300:40");
  // Anthropic-style counts: input and the two cache counts.
  assert.equal((await watch(() => sse(["event: message_start\ndata: {\"message\":{\"usage\":{\"input_tokens\":100,\"cache_read_input_tokens\":700,\"cache_creation_input_tokens\":50}}}\n\n", "data: {\"usage\":{\"output_tokens\":12}}\n\n"], )))[2], "finished:true:850:750:12");
  // A reply with no counts still ends well.
  assert.equal((await watch(() => sse(["data: a\n\n"])))[2], "finished:true:-:-:-");
  // A refused call (500) is told started then failed, with no first output; so is a call that cannot reach the endpoint.
  assert.deepEqual(await watch(() => new Response("no", { status: 500 })), ["started:true", "finished:false:-:-:-"]);
  // A reply the reader leaves part way is told as failed, once.
  const cancelled = await watch(() => sse(["data: a\n\n", "data: b\n\n", "data: c\n\n"]), "chat/completions", { cancelAfter: 1 });
  assert.deepEqual(cancelled, ["started:true", "first", "finished:false:-:-:-"]);
  // A token-count probe is not a model call.
  assert.deepEqual(await watch(() => new Response("{\"input_tokens\":5}", { status: 200 }), "messages/count_tokens"), []);
  // A monitor that throws leaves the call alone.
  const { relay } = setup({ respond: () => sse(["data: a\n\n", usage]) });
  const boom = (): never => { throw new Error("boom"); };
  const attempt = relay.forAttempt({ route: "llama/local", monitor: { started: boom, firstOutput: boom, progress: boom, finished: boom }, progressMs: 1 });
  assert.equal(await text((await attempt.relay(req("http://relay.invalid/m0/chat/completions"))).body), `data: a\n\n${usage}`);
});
