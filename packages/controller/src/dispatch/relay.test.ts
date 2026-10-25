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
