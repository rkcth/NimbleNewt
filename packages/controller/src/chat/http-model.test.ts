import assert from "node:assert/strict";
import { test } from "node:test";
import { HttpModelCall } from "./http-model.js";
import { ModelInterpreter } from "./model-interpreter.js";

const ok = (content: string): Response => new Response(JSON.stringify({ choices: [{ message: { content } }] }), { status: 200 });
const input = { text: "move the garden task to done", quoted: [], focus: {}, proposals: [] };
const good = JSON.stringify([{ kind: "none", reason: "nothing asked" }]);

test("a completion goes to the route's endpoint with the credential, deterministically and unstreamed, and returns the text", async () => {
  const seen: { url: string; auth: string | null; body: Record<string, unknown> }[] = [];
  const m = new HttpModelCall({
    endpoint: (r) => (r === "llama/local" ? { url: "http://llama:8080/v1/", headers: () => ({ authorization: "Bearer sk-secret-123456789012345678901234" }) } : undefined),
    fetch: async (url, init) => { seen.push({ url: String(url), auth: new Headers(init?.headers).get("authorization"), body: JSON.parse(String(init?.body)) as Record<string, unknown> }); return ok("hello"); },
  });
  assert.equal(await m.complete("llama/local", { system: "s", user: "u" }), "hello");
  assert.equal(seen[0]!.url, "http://llama:8080/v1/chat/completions");
  assert.match(seen[0]!.auth ?? "", /^Bearer sk-secret/);
  assert.deepEqual([seen[0]!.body["model"], seen[0]!.body["temperature"], seen[0]!.body["stream"]], ["local", 0, false]);
  await assert.rejects(m.complete("nowhere/x", { system: "s", user: "u" }), /no endpoint/);
});

test("failures are thrown with their class and never carry the credential; the interpreter falls back across routes built on it", async () => {
  const failures: string[] = [];
  const replies: Record<string, () => Response> = {
    "a/credit": () => new Response("insufficient_quota: sk-secret-123456789012345678901234", { status: 402 }),
    "b/rate": () => new Response("slow down", { status: 429 }),
    "c/down": () => new Response("bad gateway", { status: 502 }),
    "d/text": () => ok("not a list but prose"),
    "e/ok": () => ok(good),
  };
  const m = new HttpModelCall({ endpoint: () => ({ url: "http://x/v1" }), fetch: async () => replies[currentRoute]!(), onFailure: (_r, k) => failures.push(k) });
  let currentRoute = "a/credit";
  const routes = Object.keys(replies);
  const wrapped = { complete: async (route: string, r: { system: string; user: string }) => { currentRoute = route; return m.complete(route, r); } };
  const out = await new ModelInterpreter(wrapped, () => routes.slice(0, 3).concat(["e/ok"])).interpret(input);
  assert.deepEqual(out, JSON.parse(good));
  assert.deepEqual(failures, ["credit", "rate-limit", "outage"]);
  currentRoute = "a/credit";
  await assert.rejects(m.complete("a/credit", { system: "s", user: "u" }), (e: Error) => /^credit:/.test(e.message) && !e.message.includes("sk-secret"));
  const empty = new HttpModelCall({ endpoint: () => ({ url: "http://x/v1" }), fetch: async () => new Response("{\"choices\":[]}", { status: 200 }) });
  await assert.rejects(empty.complete("a/b", { system: "s", user: "u" }), /held no text/);
});

test("a refused connection, a body that never ends and an error inside a 200 reply are classified", async () => {
  const seen: string[] = [];
  const mk = (fetch: typeof globalThis.fetch) => new HttpModelCall({ endpoint: () => ({ url: "http://x/v1" }), fetch, timeoutMs: 100, onFailure: (_r, k) => seen.push(k) });
  const refused = mk(async () => { throw Object.assign(new TypeError("fetch failed"), { cause: { code: "ECONNREFUSED" } }); });
  await assert.rejects(refused.complete("a/b", { system: "s", user: "u" }), /^Error: outage/);
  const drip = mk(async (_url, init) => new Response(new ReadableStream({ start(c) { c.enqueue(new TextEncoder().encode("{")); init?.signal?.addEventListener("abort", () => c.error(init.signal!.reason)); } }), { status: 200 }));
  const keepAlive = setTimeout(() => undefined, 5000); // the timeout signal's own timer does not hold the process open
  await assert.rejects(drip.complete("a/b", { system: "s", user: "u" }), /timed out|abort/i);
  clearTimeout(keepAlive);
  const quota = mk(async () => new Response(JSON.stringify({ error: { message: "insufficient_quota" } }), { status: 200 }));
  await assert.rejects(quota.complete("a/b", { system: "s", user: "u" }), /^Error: credit/);
  assert.deepEqual(seen, ["outage", "outage", "credit"], "each was reported with its class");
  const typed = mk(async () => new Response(JSON.stringify({ error: { type: "insufficient_quota" } }), { status: 200 }));
  await assert.rejects(typed.complete("a/b", { system: "s", user: "u" }), /^Error: credit/);
  const nullCause = mk(async () => { throw Object.assign(new TypeError("fetch failed"), { cause: null }); });
  await assert.rejects(nullCause.complete("a/b", { system: "s", user: "u" }), /fetch failed/);
});
