import assert from "node:assert/strict";
import { test } from "node:test";
import { ModelRelay, type RelayRequest } from "./relay.js";
import { applyRouteBudget } from "./route-budget.js";
import type { RouteBudget } from "../routing/policy.js";

// Card W07: a route's length and reasoning budget in the request the provider receives. The field names per provider kind, and the relay applying them at every call.

const apply = (body: Record<string, unknown>, wire: "chat/completions" | "messages", kind: string | undefined, budget: RouteBudget) => { const b = structuredClone(body); const r = applyRouteBudget(b, wire, kind, budget); return { body: b, ...r }; };

test("the reply limit and reasoning cap use each provider kind's own field names on chat/completions", () => {
  const pi = { model: "m", messages: [], max_tokens: 32_000, stream: true };
  for (const kind of ["vllm", "radiance"]) {
    const r = apply(pi, "chat/completions", kind, { maxTokens: 8000, reasoningTokens: 2000 });
    assert.deepEqual([r.body["max_tokens"], r.body["thinking_token_budget"], r.notSent], [8000, 2000, []], kind);
    assert.deepEqual(r.sent, { max_tokens: 8000, thinking_token_budget: 2000 });
  }
  const llama = apply(pi, "chat/completions", "llama-cpp", { maxTokens: 8000, reasoningTokens: 2000 });
  assert.deepEqual([llama.body["max_tokens"], llama.body["thinking_budget_tokens"], llama.body["thinking_token_budget"]], [8000, 2000, undefined]);
  // OpenAI names the reply limit max_completion_tokens, and takes no token cap for reasoning: that part is said, not sent.
  const openai = apply({ ...pi }, "chat/completions", "openai", { maxTokens: 8000, reasoningTokens: 2000 });
  assert.deepEqual([openai.body["max_completion_tokens"], openai.body["max_tokens"], openai.body["thinking_token_budget"]], [8000, undefined, undefined], "the other name is removed: no two limits that disagree");
  assert.equal(openai.notSent.length, 1);
  assert.match(openai.notSent[0]!, /reasoning cap \(2000 tokens\) was not sent: this provider takes a reasoning effort level/);
  for (const kind of ["strata", "openai-compatible"]) {
    const r = apply({ ...pi, max_completion_tokens: 5 }, "chat/completions", kind, { maxTokens: 8000, reasoningTokens: 2000 });
    assert.deepEqual([r.body["max_tokens"], r.body["max_completion_tokens"]], [8000, undefined], kind);
    assert.match(r.notSent.join(), /reasoning cap \(2000 tokens\) was not sent: the endpoint's kind \(.+\) has no known field/);
  }
});

test("an endpoint whose kind is not set, or not known, is sent neither figure, and both are said", () => {
  const pi = { model: "m", messages: [], max_tokens: 1024 };
  for (const kind of [undefined, "generic", "claude", "mystery-server"]) {
    const r = apply(pi, "chat/completions", kind, { maxTokens: 8000, reasoningTokens: 2000 });
    assert.deepEqual(r.body, pi, `${kind}: the body is as the runtime built it`);
    assert.deepEqual(r.sent, {});
    assert.equal(r.notSent.length, 2, String(kind));
    assert.match(r.notSent[0]!, kind === undefined ? /reply limit \(8000 tokens\) was not sent: the endpoint's kind is not set/ : /reply limit \(8000 tokens\) was not sent: the endpoint's kind \(.+\) has no known field/);
  }
});

test("on Anthropic's Messages API the reply limit is max_tokens and the reasoning cap lowers a thinking budget, but never makes a call reason", () => {
  const thinks = { model: "c", messages: [], max_tokens: 64_000, thinking: { type: "enabled", budget_tokens: 30_000 } };
  const r = apply(thinks, "messages", undefined, { maxTokens: 16_000, reasoningTokens: 4000 });
  assert.deepEqual([r.body["max_tokens"], r.body["thinking"]], [16_000, { type: "enabled", budget_tokens: 4000 }]);
  assert.deepEqual(r.sent, { max_tokens: 16_000, "thinking.budget_tokens": 4000 });
  // An adaptive thinking request is left as it is (current Claude models refuse a fixed budget with a 400, so converting it would fail every call of the route), and that is said; a smaller budget asked is kept.
  const adaptive = { type: "adaptive", display: "summarized", block_binding: { prefix_mismatch_behavior: "drop_block" } };
  const ad = apply({ ...thinks, thinking: adaptive }, "messages", "claude", { maxTokens: 16_000, reasoningTokens: 4000 });
  assert.deepEqual([ad.body["thinking"], ad.body["max_tokens"], ad.sent], [adaptive, 16_000, { max_tokens: 16_000 }]);
  assert.match(ad.notSent.join(), /reasoning cap \(4000 tokens\) was not sent: this call uses adaptive thinking, which takes an effort level/);
  assert.deepEqual(apply({ ...thinks, thinking: { type: "enabled", budget_tokens: 2000 } }, "messages", "claude", { reasoningTokens: 4000 }).body["thinking"], { type: "enabled", budget_tokens: 2000 });
  // A call that does not reason is not made to.
  const plain = apply({ model: "c", messages: [], max_tokens: 64_000 }, "messages", "claude", { reasoningTokens: 4000 });
  assert.deepEqual([plain.body["thinking"], plain.sent, plain.notSent], [undefined, {}, []]);
  assert.deepEqual(apply({ ...thinks, thinking: { type: "disabled" } }, "messages", "claude", { reasoningTokens: 4000 }).body["thinking"], { type: "disabled" });
  // Below the provider's smallest reasoning budget, reasoning is turned off, which stays within the cap, and that is said.
  const low = apply(thinks, "messages", "claude", { reasoningTokens: 500 });
  assert.deepEqual(low.body["thinking"], { type: "disabled" });
  assert.match(low.notSent[0]!, /below the provider's smallest reasoning budget \(1024\)/);
  // The budget stays below the reply limit the body carries.
  assert.deepEqual(apply({ ...thinks, max_tokens: 3000 }, "messages", "claude", { reasoningTokens: 4000 }).body["thinking"], { type: "enabled", budget_tokens: 2999 });

  // A reply limit alone still keeps the runtime's fixed budget below it (Anthropic refuses budget_tokens >= max_tokens), and turns reasoning off when no 1024 fits.
  const lowered = apply({ ...thinks, thinking: { type: "enabled", budget_tokens: 8192, display: "summarized" } }, "messages", undefined, { maxTokens: 4000 });
  assert.deepEqual([lowered.body["max_tokens"], lowered.body["thinking"], lowered.notSent], [4000, { type: "enabled", budget_tokens: 3999, display: "summarized" }, []]);
  const tiny = apply(thinks, "messages", undefined, { maxTokens: 1000 });
  assert.deepEqual(tiny.body["thinking"], { type: "disabled" });
  assert.match(tiny.notSent.join(), /reply limit \(1000 tokens\) leaves no room for the provider's smallest reasoning budget/);
  assert.deepEqual(apply({ ...thinks, thinking: { type: "enabled", budget_tokens: 2000 } }, "messages", undefined, { maxTokens: 16_000 }).body["thinking"], { type: "enabled", budget_tokens: 2000 }, "a budget already below the limit is kept");
});

test("a reasoning cap on an OpenAI-compatible server stays below the reply limit and lowers a larger budget the runtime asked for", () => {
  assert.equal(apply({ max_tokens: 3000 }, "chat/completions", "vllm", { reasoningTokens: 4000 }).body["thinking_token_budget"], 2999);
  assert.equal(apply({ max_tokens: 30_000, thinking_token_budget: 1000 }, "chat/completions", "vllm", { reasoningTokens: 4000 }).body["thinking_token_budget"], 1000);
  assert.equal(apply({ max_tokens: 30_000, thinking_token_budget: 9000 }, "chat/completions", "vllm", { reasoningTokens: 4000 }).body["thinking_token_budget"], 4000);
  assert.deepEqual(apply({ max_tokens: 3000 }, "chat/completions", "vllm", {}), { body: { max_tokens: 3000 }, sent: {}, notSent: [] });
  // The runtime's limit may be named max_completion_tokens: the cap stays below that one too.
  assert.equal(apply({ max_completion_tokens: 3000 }, "chat/completions", "vllm", { reasoningTokens: 4000 }).body["thinking_token_budget"], 2999);
});

// ---- the relay -----------------------------------------------------------------------------------------------------------------------------------------------------------------------

function relaying(kind?: string) {
  const bodies: string[] = [];
  const fetch: typeof globalThis.fetch = async (_input, init) => {
    bodies.push(Buffer.from(init!.body as Buffer).toString("utf8"));
    return new Response("{}", { status: 200, headers: { "content-type": "application/json" } });
  };
  const relay = new ModelRelay({ endpoint: () => ({ url: "http://vllm.internal/v1", ...(kind === undefined ? {} : { kind }) }), fetch });
  return { bodies, relay };
}
const call = (path: string, body: object): RelayRequest => ({ url: `http://relay.invalid/m0/${path}`, method: "POST", headers: [["content-type", "application/json"]], body: Buffer.from(JSON.stringify(body)), signal: new AbortController().signal });
const PI_BODY = { model: "local", messages: [{ role: "user", content: "hi" }], max_tokens: 1024, stream: true };

test("the relay puts the route's budget in every call it sends, read at each call, so a change applies from the next call", async () => {
  const { bodies, relay } = relaying("vllm");
  let budget: RouteBudget | undefined = { maxTokens: 4000, reasoningTokens: 1500 };
  let asked = 0; let gated = 0;
  const applied: unknown[] = [];
  const attempt = relay.forAttempt({ route: "localp/small", budget: async () => { asked++; return budget; }, gate: async () => { gated++; return undefined; }, onBudget: (a) => applied.push(a) });
  await attempt.relay(call("chat/completions", PI_BODY));
  assert.deepEqual(JSON.parse(bodies[0]!), { ...PI_BODY, max_tokens: 4000, thinking_token_budget: 1500 }, "the provider receives the route's figures");
  assert.deepEqual(applied[0], { sent: { max_tokens: 4000, thinking_token_budget: 1500 }, notSent: [] });
  budget = { maxTokens: 6000 };
  await attempt.relay(call("chat/completions", PI_BODY));
  assert.deepEqual(JSON.parse(bodies[1]!), { ...PI_BODY, max_tokens: 6000 }, "the next call carries the changed budget");
  budget = undefined;
  await attempt.relay(call("chat/completions", PI_BODY));
  assert.equal(bodies[2], JSON.stringify(PI_BODY), "no budget: the body is sent exactly as the runtime built it");
  // A token count is no model call: it is not given a reply limit, and the budget is not even asked.
  budget = { maxTokens: 6000 };
  const before = asked;
  await attempt.relay(call("messages/count_tokens", { model: "local", messages: [] }));
  assert.deepEqual([JSON.parse(bodies[3]!), asked], [{ model: "local", messages: [] }, before]);
  assert.equal(gated, 3, "each model call passed the spending gate once; the budget adds no call and no second count");
});

test("a route with no budget, or a relay given none, sends the runtime's body byte for byte (today's behaviour)", async () => {
  const { bodies, relay } = relaying("vllm");
  const raw = '{"model":"local",  "max_tokens":1024}';
  const send = { url: "http://relay.invalid/m0/chat/completions", method: "POST", headers: [["content-type", "application/json"]] as [string, string][], body: Buffer.from(raw), signal: new AbortController().signal };
  await relay.forAttempt({ route: "localp/small" }).relay(send);
  await relay.forAttempt({ route: "localp/small", budget: () => ({}) }).relay(send);
  await relay.forAttempt({ route: "localp/small", budget: () => undefined }).relay(send);
  assert.deepEqual(bodies, [raw, raw, raw]);
});

test("an endpoint of unknown kind is sent no figure and the relay says so; a budget that cannot be read refuses the call", async () => {
  const { bodies, relay } = relaying();
  const told: { notSent: readonly string[] }[] = [];
  await relay.forAttempt({ route: "localp/small", budget: () => ({ maxTokens: 4000 }), onBudget: (a) => told.push(a) }).relay(call("chat/completions", PI_BODY));
  assert.deepEqual(JSON.parse(bodies[0]!), PI_BODY);
  assert.match(told[0]!.notSent[0]!, /reply limit \(4000 tokens\) was not sent: the endpoint's kind is not set/);
  // The owner's cache endpoint configuration can name the kind when the endpoint does not.
  await relay.forAttempt({ route: "localp/small", kind: "llama-cpp", budget: () => ({ maxTokens: 4000, reasoningTokens: 100 }) }).relay(call("chat/completions", PI_BODY));
  assert.deepEqual(JSON.parse(bodies[1]!), { ...PI_BODY, max_tokens: 4000, thinking_budget_tokens: 100 });
  await assert.rejects(relay.forAttempt({ route: "localp/small", budget: async () => { throw new Error("store down"); } }).relay(call("chat/completions", PI_BODY)), /budget could not be read/);
  await assert.rejects(relay.forAttempt({ route: "localp/small", budget: () => ({ maxTokens: 10 }) }).relay({ ...call("chat/completions", PI_BODY), body: Buffer.from("not json") }), /not JSON/);
  assert.equal(bodies.length, 2, "nothing was sent for the refused calls");
});
