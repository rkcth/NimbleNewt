import assert from "node:assert/strict";
import { test } from "node:test";
import { CacheAdapter, deriveKey, piCachePolicy, profileFor, sharedPrefixBreakpoints, type CacheContext } from "./index.js";
import { LlamaSim } from "./simulators.js";

// Card C06b: what the dispatcher gives the Pi adapter for one model, and the Claude breakpoint that sits between the system text agents share and the text only one agent has.

const scopeKey = deriveKey("installation-secret-0123", "scope", "proj-a");
const shareKey = deriveKey("installation-secret-0123", "share", "proj-a");
const ctx = (extra: Partial<CacheContext> = {}): CacheContext => ({ scopeKey, shareKey, ...extra });
const long = (n: number): string => "x".repeat(n);
const claudeBody = (extra: Record<string, unknown> = {}) => ({
  model: "claude-opus-5-5", max_tokens: 100,
  tools: [{ name: "a", description: long(900), input_schema: { type: "object" } }, { name: "b", description: long(900), input_schema: { type: "object" } }],
  system: [{ type: "text", text: long(2000) }, { type: "text", text: long(2000) }],
  messages: [{ role: "user", content: [{ type: "text", text: long(2000) }] }],
  ...extra,
});
const marked = (body: Record<string, unknown>): string[] => [
  ...(body["tools"] as { cache_control?: { ttl: string } }[]).map((t, i) => (t.cache_control === undefined ? "" : `tool${i}:${t.cache_control.ttl}`)),
  ...(body["system"] as { cache_control?: { ttl: string } }[]).map((s, i) => (s.cache_control === undefined ? "" : `system${i}:${s.cache_control.ttl}`)),
  ...(body["messages"] as { content: { cache_control?: { ttl: string } }[] }[]).flatMap((m, i) => m.content.map((c) => (c.cache_control === undefined ? "" : `message${i}:${c.cache_control.ttl}`))),
].filter((x) => x !== "");

test("Claude: with the shared system block split off, breakpoints sit after the tools, after the shared block, after the agent's text and on the last message, the three head ones for an hour", () => {
  const profile = profileFor({ kind: "claude", model: "claude-opus-5-5" });
  assert.deepEqual(sharedPrefixBreakpoints("long").map((b) => b.ttl), ["1h", "1h", "1h", "5m"]);
  assert.deepEqual(sharedPrefixBreakpoints(undefined).map((b) => b.ttl), ["5m", "5m", "5m", "5m"]);
  const policy = piCachePolicy(profile, ctx({ retention: "long" }), { splitSystem: true });
  assert.deepEqual(marked(policy.payload(claudeBody()) as Record<string, unknown>), ["tool1:1h", "system0:1h", "system1:1h", "message0:5m"]);
  // Without the split there is one system block and the default plan applies.
  const unsplit = piCachePolicy(profile, ctx({ retention: "long" }));
  assert.deepEqual(marked(unsplit.payload(claudeBody({ system: [{ type: "text", text: long(4000) }] })) as Record<string, unknown>), ["system0:1h", "message0:5m"]);
  // A caller's own breakpoints win; plain removes every marker.
  assert.deepEqual(marked(piCachePolicy(profile, ctx({ breakpoints: [{ at: "last-message", ttl: "5m" }] }), { splitSystem: true }).payload(claudeBody()) as Record<string, unknown>), ["message0:5m"]);
  assert.deepEqual(marked(piCachePolicy(profile, ctx({ plain: true }), { splitSystem: true }).payload(claudeBody()) as Record<string, unknown>), []);
});

test("Claude: a system block that is not there, or a breakpoint that would not reach the model's minimum, is skipped with the reason, never placed", () => {
  const profile = profileFor({ kind: "claude", model: "claude-opus-5-5" });
  const one = profile.prepare(claudeBody({ system: [{ type: "text", text: long(2000) }] }), ctx({ breakpoints: [{ at: { systemBlock: 3 }, ttl: "5m" }] }));
  assert.deepEqual(one.applied, []);
  assert.match(one.skipped.join(" "), /system block 3: there is no such system block/);
  const small = profile.prepare(claudeBody({ tools: [], system: [{ type: "text", text: "tiny" }, { type: "text", text: "tiny" }], messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }] }), ctx({ breakpoints: [{ at: { systemBlock: 0 }, ttl: "1h" }] }));
  assert.match(small.skipped.join(" "), /under the 512-token minimum/);
  // A system prompt given as a plain string is turned into one block so it can carry the marker.
  const text = profile.prepare(claudeBody({ system: long(2000) }), ctx({ breakpoints: [{ at: { systemBlock: 0 }, ttl: "5m" }] }));
  assert.deepEqual(marked(text.body), ["system0:5m"]);
  assert.throws(() => profile.prepare(claudeBody(), ctx({ breakpoints: [...sharedPrefixBreakpoints("long"), { at: { message: 0 }, ttl: "5m" }] })), /at most 4 per request/);
});

test("the key is the shared prefix's key (falling back to the project's), never a task or session ID; retention follows the backend; a backend that assumes nothing gets nothing", () => {
  const vllm = profileFor({ kind: "vllm", model: "m" });
  assert.equal(piCachePolicy(vllm, ctx()).key, shareKey);
  assert.equal(piCachePolicy(vllm, { scopeKey }).key, scopeKey);
  assert.match(shareKey, /^nn-[A-Za-z0-9_-]{27}$/);
  assert.equal(piCachePolicy(vllm, ctx({ retention: "long" })).retention, undefined, "vLLM has no request-level retention to set");
  const openai = profileFor({ kind: "openai", model: "gpt-x", options: { promptCacheKey: true, extendedRetention: true } });
  assert.equal(piCachePolicy(openai, ctx({ retention: "long" })).retention, "long");
  assert.equal(piCachePolicy(openai, ctx({ plain: true })).retention, "none");
  assert.equal(piCachePolicy(openai, ctx({ plain: true })).key, undefined);
  const generic = piCachePolicy(profileFor({ model: "claude-called-this-but-unconfigured" }), ctx({ retention: "long" }));
  assert.deepEqual([generic.key, generic.retention], [undefined, undefined]);
  const body = { messages: [{ role: "user", content: "hi" }] };
  assert.deepEqual(generic.payload(body), body);
  assert.equal(generic.payload("not a body"), "not a body");
  assert.equal(generic.payload(null), null);
});

test("the payload function is the profile's own preparation: vLLM gets its salt and the input is left untouched", () => {
  const input = { messages: [{ role: "user", content: "hi" }] };
  assert.equal((piCachePolicy(profileFor({ kind: "vllm", model: "m" }), ctx()).payload(input) as Record<string, unknown>)["cache_salt"], scopeKey);
  assert.deepEqual(input, { messages: [{ role: "user", content: "hi" }] });
});

test("a slotted llama.cpp server is never given a slot or reuse through Pi's own calls: project B cannot read the KV project A left in slot 0", async () => {
  const profile = profileFor({ kind: "llama-cpp", model: "m", options: { slots: 2 } });
  const sim = new LlamaSim(2);
  const a = new CacheAdapter(profile, sim);
  const prompt = { messages: [{ role: "system", content: "A".repeat(2000) }, { role: "user", content: "go" }] };
  await a.call(prompt, ctx({ slot: 0 }));
  assert.equal(sim.slots[0]!.length > 0, true, "project A's prompt is in slot 0");
  const scopeB = deriveKey("installation-secret-0123", "scope", "proj-b");
  const policy = piCachePolicy(profile, { scopeKey: scopeB, slot: 0 });
  assert.match(policy.degraded ?? "", /slotted server/);
  const body = policy.payload(prompt) as Record<string, unknown>;
  assert.equal(body["cache_prompt"], false);
  assert.equal("id_slot" in body, false);
  const res = await sim.send({ method: "POST", path: "/v1/chat/completions", headers: {}, body: body as never });
  assert.equal(profile.read(res.body).cachedTokens, 0, "nothing of A's slot was read");
});

test("a project that requires isolation gets no cache setting on a backend that cannot keep projects apart, in the key, the retention or the body, for every profile", () => {
  const withKey = { messages: [{ role: "user", content: "hi" }], prompt_cache_key: "pi-session", prompt_cache_retention: "24h", cache_salt: "x" };
  for (const [kind, options, isolates] of [
    ["openai", { promptCacheKey: true, extendedRetention: true }, false], ["openai-compatible", { promptCacheKey: true }, false], ["claude", {}, false], ["radiance", {}, false], ["strata", {}, false],
    ["llama-cpp", { slots: 2 }, false], ["generic", {}, false], ["vllm", {}, true],
  ] as const) {
    const profile = profileFor({ kind, model: kind === "claude" ? "claude-opus-5-5" : "m", options });
    const policy = piCachePolicy(profile, ctx({ retention: "long", isolationRequired: true, slot: 0 }), { splitSystem: true });
    const body = (profile.wire === "anthropic-messages" ? claudeBody() : withKey);
    const out = policy.payload(body) as Record<string, unknown>;
    if (isolates) {
      assert.equal(policy.key, shareKey, `${kind}: a salt isolates, so the cache stays on`);
      assert.equal(out["cache_salt"], scopeKey);
      continue;
    }
    assert.equal(policy.key, undefined, kind);
    assert.equal(policy.retention, kind === "generic" ? undefined : "none", kind);
    assert.equal("prompt_cache_key" in out || "prompt_cache_retention" in out, false, `${kind}: the SDK's key and retention are removed from the body`);
    assert.ok(!JSON.stringify(out).includes("cache_control"), kind);
    assert.notEqual(out["cache_prompt"], true, kind);
  }
});
