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
