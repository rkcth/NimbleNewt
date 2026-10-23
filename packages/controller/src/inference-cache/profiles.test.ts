import assert from "node:assert/strict";
import { test } from "node:test";
import { DomainError } from "../domain/errors.js";
import { BACKEND_KINDS, CLAUDE_MIN_TOKENS, SlotAffinity, deriveKey, negotiate, profileFor, type CacheContext, type EndpointConfig, type WireRequest } from "./index.js";

const scope = deriveKey("installation-secret-0123", "scope", "proj-a");
const ctx = (extra: Partial<CacheContext> = {}): CacheContext => ({ scopeKey: scope, ...extra });
const chat = (extra: WireRequest = {}): WireRequest => ({ model: "m", messages: [{ role: "system", content: "You are careful." }, { role: "user", content: "hello" }], ...extra });
const refuses = (run: () => unknown, field?: string): void => assert.throws(run, (e: unknown) => { assert.ok(e instanceof DomainError, String(e)); if (field !== undefined) assert.equal(e.field, field); return true; });
const text = (n: number): string => "x".repeat(n * 3);

test("the profile comes from the configured kind only: a model name, an address or a misspelt kind never selects a tuned profile", () => {
  for (const kind of BACKEND_KINDS) assert.equal(profileFor({ kind, model: "m" }).kind, kind);
  for (const model of ["claude-opus-5-5", "gpt-4o", "llama-3.1-8b", "qwen3.8-27b", "vllm/anything", "radiance-flash", "strata"]) assert.equal(profileFor({ model }).kind, "generic", model);
  assert.equal(profileFor({ kind: "Claude", model: "claude-opus-5-5" }).kind, "generic", "kinds are matched exactly");
  assert.equal(profileFor({ kind: "anthropic", model: "claude-opus-5-5" }).kind, "generic");
  assert.equal(profileFor({ kind: "https://api.openai.com/v1", model: "gpt-5" }).kind, "generic", "an address is not a kind");
  refuses(() => profileFor({ model: "m", extra: 1 } as unknown as EndpointConfig), "endpoint.extra");
  refuses(() => profileFor({ kind: "vllm", model: "m", options: { prefixcaching: true } } as unknown as EndpointConfig), "endpoint.options.prefixcaching");
  refuses(() => profileFor({ kind: "llama-cpp", model: "m", options: { slots: 0 } }), "endpoint.options.slots");
  refuses(() => profileFor({ kind: "claude", model: "m", options: { minPrefixTokens: 1.5 } }), "endpoint.options.minPrefixTokens");
  refuses(() => profileFor({ kind: "openai", model: "" }), "endpoint.model");
});

test("generic: assumes nothing, sends nothing, expects nothing, and still reads a standard hit field when one is present", () => {
  const p = profileFor({ model: "mystery" });
  const r = chat();
  const out = p.prepare(r, ctx({ slot: 1, retention: "long", oneShot: true }));
  assert.deepEqual(out.body, r);
  assert.deepEqual([out.applied, out.skipped, out.expects], [[], [], "no"]);
  assert.deepEqual([p.capabilities.prefixReuse, p.capabilities.pin.level, p.capabilities.fork.level, p.capabilities.slotSaveRestore.level, p.capabilities.decoderResume.level], ["none", "unsupported", "unsupported", "unsupported", "unsupported"]);
  assert.equal(p.read({ usage: { prompt_tokens: 100 } }).known, false);
  assert.deepEqual(p.read({ usage: { prompt_tokens: 100, prompt_tokens_details: { cached_tokens: 40 } } }), { known: true, source: "usage.prompt_tokens_details.cached_tokens", promptTokens: 100, cachedTokens: 40, computedTokens: 60, writtenTokens: 0 });
  assert.equal(p.refusedCacheSetting({ status: 400, message: "unknown field cache_salt" }), false);
});

test("no profile changes its input, and every one is deterministic", () => {
  const kinds: EndpointConfig[] = [
    { kind: "llama-cpp", model: "m", options: { slots: 4 } }, { kind: "vllm", model: "m" }, { kind: "radiance", model: "m" }, { kind: "strata", model: "m", options: { pinPrefix: true } },
    { kind: "openai", model: "m", options: { extendedRetention: true } }, { kind: "openai-compatible", model: "m", options: { promptCacheKey: true } }, { kind: "claude", model: "claude-opus-5-5" }, { model: "m" },
  ];
  for (const k of kinds) {
    const p = profileFor(k);
    const r = chat({ system: text(900), messages: [{ role: "user", content: text(900) }, { role: "assistant", content: "ok" }, { role: "user", content: "next" }] });
    const before = JSON.stringify(r);
    const a = p.prepare(r, ctx({ slot: 1, retention: "long", pinMessages: 1, prefixTokens: 5000 }));
    assert.equal(JSON.stringify(r), before, `${p.kind} changed its input`);
    assert.equal(JSON.stringify(p.prepare(r, ctx({ slot: 1, retention: "long", pinMessages: 1, prefixTokens: 5000 }))), JSON.stringify(a), `${p.kind} is not deterministic`);
    const plain = p.prepare(r, ctx({ plain: true }));
    assert.deepEqual([plain.applied, plain.expects], [[], "no"], `${p.kind} plain`);
    assert.ok(!JSON.stringify(plain.body).includes("cache_control"), `${p.kind} plain still has markers`);
  }
});

test("llama.cpp: cache_prompt and a slot per group; hits from timings.cache_n and prompt_n; slot files only where configured", () => {
  const p = profileFor({ kind: "llama-cpp", model: "m", options: { slots: 4, slotSave: true } });
  const out = p.prepare(chat(), ctx({ slot: 2 }));
  assert.deepEqual([out.body["cache_prompt"], out.body["id_slot"], out.applied, out.expects], [true, 2, ["cache_prompt", "id_slot"], "yes"]);
  const outside = p.prepare(chat(), ctx({ slot: 4 }));
  assert.equal(outside.body["id_slot"], undefined);
  assert.match(outside.skipped.join(), /outside the 4 configured/);
  assert.match(profileFor({ kind: "llama-cpp", model: "m" }).prepare(chat(), ctx({ slot: 0 })).skipped.join(), /number of slots is not configured/);
  // A llama-server response shape (source-derived, not captured from a running server) (non-streaming chat completion with timings).
  const shape = { id: "chatcmpl-1", object: "chat.completion", usage: { prompt_tokens: 1200, completion_tokens: 40, total_tokens: 1240 }, timings: { cache_n: 1000, prompt_n: 200, prompt_ms: 81.2, predicted_n: 40, predicted_ms: 900 } };
  assert.deepEqual(p.read(shape), { known: true, source: "timings.cache_n + timings.prompt_n", promptTokens: 1200, cachedTokens: 1000, computedTokens: 200, writtenTokens: 0 });
  assert.equal(p.read({ usage: { prompt_tokens: 5 } }).known, false, "no figure is unknown, not zero");
  assert.deepEqual(p.read({ timings: { cache_n: 0, prompt_n: 300 } }).cachedTokens, 0);
  assert.equal(p.read({ timings: { cache_n: -1, prompt_n: 3 } }).known, false);
  assert.equal(p.read({ timings: { cache_n: "7", prompt_n: 3 } }).known, false);
  assert.equal(p.read("not json").known, false);
  assert.deepEqual(p.slotRequest!("save", 1, "nn-abcdefgh2345.bin"), { method: "POST", path: "/slots/1?action=save", body: { filename: "nn-abcdefgh2345.bin" } });
  assert.deepEqual(p.clearSlotRequest!(1), { method: "POST", path: "/slots/1?action=erase", body: {} });
  assert.equal(profileFor({ kind: "strata", model: "m" }).clearSlotRequest, undefined, "Strata has no slot clear");
  for (const bad of ["../x.bin", "nn-abc.bin", "/etc/passwd", "nn-abcdefgh2345.bin/../x", "nn-ABCDEFGH2345.bin"]) refuses(() => p.slotRequest!("restore", 1, bad), "filename");
  refuses(() => p.slotRequest!("save", 1), "filename");
  refuses(() => profileFor({ kind: "llama-cpp", model: "m" }).slotRequest!("save", 0, "nn-abcdefgh2345.bin"), "slotSave");
  assert.equal(p.capabilities.slotSaveRestore.level, "available");
  assert.equal(profileFor({ kind: "llama-cpp", model: "m" }).capabilities.slotSaveRestore.level, "unsupported");
  assert.equal(p.capabilities.decoderResume.level, "unsupported");
  assert.match(p.caveats.join(" "), /idle slot/);
});

test("vLLM: cache_salt per project, hits from cached_tokens only when the server reports them", () => {
  const p = profileFor({ kind: "vllm", model: "m" });
  const a = p.prepare(chat(), ctx());
  assert.equal(a.body["cache_salt"], scope);
  const other = deriveKey("installation-secret-0123", "scope", "proj-b");
  assert.notEqual(p.prepare(chat(), ctx({ scopeKey: other })).body["cache_salt"], a.body["cache_salt"]);
  refuses(() => p.prepare(chat(), ctx({ scopeKey: "proj-a/raw name" })), "scopeKey");
  const shape = { usage: { prompt_tokens: 2048, completion_tokens: 10, total_tokens: 2058, prompt_tokens_details: { cached_tokens: 2032 } } };
  assert.deepEqual([p.read(shape).cachedTokens, p.read(shape).computedTokens], [2032, 16]);
  assert.equal(p.read({ usage: { prompt_tokens: 2048, completion_tokens: 10 } }).known, false);
  const blind = profileFor({ kind: "vllm", model: "m", options: { promptDetails: false } });
  assert.equal(blind.read(shape).known, false, "configured without prompt-token details: not read");
  assert.match(blind.read(shape).caveat ?? "", /enable-prompt-tokens-details/);
  const off = profileFor({ kind: "vllm", model: "m", options: { prefixCaching: false } });
  assert.deepEqual([off.prepare(chat(), ctx()).applied, off.prepare(chat(), ctx()).expects, off.capabilities.prefixReuse, off.capabilities.fork.level], [[], "no", "none", "unsupported"]);
  assert.deepEqual([p.capabilities.pin.level, p.capabilities.fork.level, p.capabilities.isolation], ["unsupported", "available", "request-salt"]);
  assert.ok(p.neverCall.includes("/reset_prefix_cache"));
  assert.equal(p.refusedCacheSetting({ status: 400, message: "Unrecognized request argument: cache_salt" }), true);
  assert.equal(p.refusedCacheSetting({ status: 500, message: "cache_salt" }), false);
});

test("Radiance: only the session label is sent, hits from cache_n and prompt_n with the hybrid caveat, never the cache reset", () => {
  const p = profileFor({ kind: "radiance", model: "qwen3.8-flash-next", options: { hostTier: true } });
  const out = p.prepare(chat({ cache_prompt: true, id_slot: 3 }), ctx({ shareKey: "nn-share", slot: 2 }));
  assert.equal(out.body["session_id"], "nn-share");
  assert.deepEqual(out.applied, ["session_id"]);
  assert.equal(out.body["prompt_cache_key"], undefined);
  // fields the caller already had are not our business, but we add none of the ignored ones
  const clean = p.prepare(chat(), ctx());
  assert.ok(!("cache_prompt" in clean.body) && !("id_slot" in clean.body) && !("prompt_cache_key" in clean.body));
  // A Radiance response shape (source-derived): usage.cached_tokens and timings (cache_n + prompt_n = prompt_tokens).
  const shape = { usage: { prompt_tokens: 20_480, completion_tokens: 64, total_tokens: 20_544, prompt_tokens_details: { cached_tokens: 20_000 } }, timings: { cache_n: 20_000, prompt_n: 480, prompt_ms: 310.5, ttft_ms: 320.1, predicted_n: 64 } };
  const hit = p.read(shape);
  assert.deepEqual([hit.known, hit.promptTokens, hit.cachedTokens, hit.computedTokens, hit.source], [true, 20_480, 20_000, 480, "timings.cache_n + timings.prompt_n"]);
  assert.match(hit.caveat ?? "", /linear-state snapshot/);
  assert.equal(profileFor({ kind: "radiance", model: "m", options: { hybrid: false } }).read(shape).caveat, undefined);
  assert.equal(p.read({ usage: { prompt_tokens: 100, prompt_tokens_details: { cached_tokens: 64 } } }).cachedTokens, 64, "falls back to usage.cached_tokens");
  assert.deepEqual(p.neverCall, ["/reset_prefix_cache"]);
  assert.match(p.capabilities.retention.via, /host tier/);
  assert.match(profileFor({ kind: "radiance", model: "m" }).capabilities.retention.via, /no host tier/);
  assert.deepEqual([p.capabilities.pin.level, p.capabilities.fork.level, p.capabilities.slotSaveRestore.level, p.capabilities.decoderResume.level], ["unsupported", "available", "unsupported", "unsupported"]);
  assert.ok(p.tuning.some((t) => t.setting === "--checkpoint-slots"));
  assert.ok(p.caveats.some((c) => /ignored/.test(c)));
});

test("Strata (latest source): one-shot calls skip checkpoints, a shared prefix is pinned only when configured and sound, newer settings are marked as newer than the installed server", () => {
  const p = profileFor({ kind: "strata", model: "m", options: { pinPrefix: true, slotSave: true } });
  assert.equal(p.prepare(chat(), ctx({ oneShot: true })).body["strata_checkpoint"], false);
  assert.equal(p.prepare(chat(), ctx()).body["strata_checkpoint"], undefined);
  assert.deepEqual(p.prepare(chat(), ctx({ pinMessages: 1, pinAuthorized: true })).body["strata_prefix"], { messages: 1 });
  assert.match(p.prepare(chat(), ctx({ pinMessages: 2, pinAuthorized: true })).skipped.join(), /leave a message after it/);
  assert.match(p.prepare(chat(), ctx({ pinMessages: 0, pinAuthorized: true })).skipped.join(), /at least one message/);
  assert.match(profileFor({ kind: "strata", model: "m" }).prepare(chat(), ctx({ pinMessages: 1, pinAuthorized: true })).skipped.join(), /not configured for pinning/);
  assert.match(p.prepare(chat(), ctx({ pinMessages: 1 })).skipped.join(), /holds no pin marker for the route/);
  assert.deepEqual([p.capabilities.pin.level, profileFor({ kind: "strata", model: "m" }).capabilities.pin.level], ["available", "unsupported"]);
  assert.deepEqual(p.slotRequest!("restore", 0, "nn-abcdefgh2345.bin").path, "/slots/0?action=restore");
  refuses(() => p.slotRequest!("save", 1, "nn-abcdefgh2345.bin"), "slot");
  const newer = p.tuning.filter((t) => t.since !== undefined).map((t) => t.setting);
  assert.deepEqual(newer, ["--conversation-cache-park-gain", "--prompt-cache-spread"]);
  assert.match(p.basis, /0\.1\.47/);
  assert.match(p.basis, /installed server is 0\.1\.43/);
  // A Strata response shape (source-derived): usage.cached_tokens and timings.
  const shape = { usage: { prompt_tokens: 43_086, completion_tokens: 12, prompt_tokens_details: { cached_tokens: 43_085 } }, timings: { cache_n: 43_085, prompt_n: 1, prompt_ms: 52.4 } };
  assert.deepEqual([p.read(shape).cachedTokens, p.read(shape).computedTokens, p.read(shape).promptTokens], [43_085, 1, 43_086]);
  assert.equal(p.refusedCacheSetting({ status: 400, message: "strata_prefix: a whole number" }), true);
});

test("OpenAI: prompt_cache_key per sharing group, 24h retention only where configured, nothing expected under the minimum; compatible services get only what the owner confirmed", () => {
  const p = profileFor({ kind: "openai", model: "gpt-x", options: { extendedRetention: true } });
  const share = deriveKey("installation-secret-0123", "share", "proj-a", "meeting-1");
  const out = p.prepare(chat(), ctx({ shareKey: share, retention: "long", prefixTokens: 4000 }));
  assert.deepEqual([out.body["prompt_cache_key"], out.body["prompt_cache_retention"], out.applied, out.expects], [share, "24h", ["prompt_cache_key", "prompt_cache_retention"], "yes"]);
  assert.equal(p.prepare(chat(), ctx()).body["prompt_cache_key"], scope, "falls back to the scope key");
  const noExt = profileFor({ kind: "openai", model: "gpt-x" }).prepare(chat(), ctx({ retention: "long" }));
  assert.equal(noExt.body["prompt_cache_retention"], undefined);
  assert.match(noExt.skipped.join(), /prompt_cache_retention/);
  const small = p.prepare(chat(), ctx({ prefixTokens: 500 }));
  assert.equal(small.expects, "no");
  assert.match(small.skipped.join(), /under the 1024-token minimum/);
  assert.equal(profileFor({ kind: "openai", model: "m", options: { minPrefixTokens: 256 } }).prepare(chat(), ctx({ prefixTokens: 300 })).expects, "yes");
  const shape = { usage: { prompt_tokens: 2006, completion_tokens: 300, total_tokens: 2306, prompt_tokens_details: { cached_tokens: 1920 } } };
  assert.deepEqual([p.read(shape).cachedTokens, p.read(shape).computedTokens], [1920, 86]);
  const responses = { usage: { input_tokens: 2006, output_tokens: 300, input_tokens_details: { cached_tokens: 1920 } } };
  assert.deepEqual([p.read(responses).known, p.read(responses).source, p.read(responses).cachedTokens], [true, "usage.input_tokens_details.cached_tokens", 1920]);
  assert.equal(p.read({ usage: { prompt_tokens: 10, prompt_tokens_details: { cached_tokens: 11 } } }).known, false, "more cached than sent is not believed");
  const c = profileFor({ kind: "openai-compatible", model: "m" });
  assert.deepEqual([c.prepare(chat(), ctx({ retention: "long" })).applied, c.prepare(chat(), ctx()).expects, c.capabilities.isolation, c.capabilities.retention.control], [[], "maybe", "none", "none"]);
  assert.equal(profileFor({ kind: "openai-compatible", model: "m", options: { promptCacheKey: true, extendedRetention: true } }).prepare(chat(), ctx({ retention: "long" })).body["prompt_cache_retention"], undefined, "retention is never sent to a compatible service");
  assert.equal(profileFor({ kind: "openai-compatible", model: "m", options: { promptCacheKey: true } }).prepare(chat(), ctx()).body["prompt_cache_key"], scope);
  assert.equal(c.read({ timings: { cache_n: 5, prompt_n: 5 } }).cachedTokens, 5, "a llama-style proxy's timings are read");
  assert.deepEqual([p.capabilities.pin.level, p.capabilities.fork.level, p.capabilities.retention.maxMs], ["unsupported", "available", 86_400_000]);
});

test("Claude: breakpoints at the stable head and the last message, lifetimes in the right order, model minimums honoured", () => {
  const p = profileFor({ kind: "claude", model: "claude-opus-5-5" });
  const big = chat({ system: text(1000), tools: [{ name: "a", description: "x", input_schema: {} }, { name: "b", description: "y", input_schema: {} }], messages: [{ role: "user", content: text(200) }, { role: "assistant", content: [{ type: "text", text: "ok" }] }, { role: "user", content: "next" }] });
  delete big["model"];
  const out = p.prepare({ model: "claude-opus-5-5", ...big }, ctx());
  assert.deepEqual(out.applied, ["cache_control system-end 5m", "cache_control last-message 5m"]);
  const system = out.body["system"] as { cache_control?: unknown; type: string }[];
  assert.deepEqual(system[0]!.cache_control, { type: "ephemeral", ttl: "5m" });
  const last = (out.body["messages"] as { content: { cache_control?: unknown }[] }[]).at(-1)!.content[0]!;
  assert.deepEqual(last.cache_control, { type: "ephemeral", ttl: "5m" });
  assert.equal(out.expects, "yes");
  // retention long: the stable head lives an hour, the tail five minutes, in that order
  const long = p.prepare({ model: "claude-opus-5-5", ...big }, ctx({ retention: "long" }));
  assert.deepEqual(long.applied, ["cache_control system-end 1h", "cache_control last-message 5m"]);
  // a 1h marker after a 5m one is lowered
  const wrong = p.prepare({ model: "claude-opus-5-5", ...big }, ctx({ breakpoints: [{ at: { message: 0 }, ttl: "5m" }, { at: "last-message", ttl: "1h" }] }));
  assert.deepEqual(wrong.applied, ["cache_control message 0 5m", "cache_control last-message 5m"]);
  assert.match(wrong.skipped.join(), /ttl 1h lowered to 5m/);
  // tools only when there is no system prompt
  const noSystem = p.prepare({ model: "claude-opus-5-5", tools: (big["tools"] as unknown[]).concat([{ name: "pad", description: text(2000), input_schema: {} }]), messages: big["messages"] }, ctx());
  assert.equal(noSystem.applied[0], "cache_control tools-end 5m");
  // too many
  refuses(() => p.prepare({ model: "m", messages: [{ role: "user", content: "x" }] }, ctx({ breakpoints: [0, 0, 0, 0, 0].map(() => ({ at: "last-message" as const, ttl: "5m" as const })) })), "breakpoints");
  refuses(() => p.prepare({ model: "m", messages: [{ role: "user", content: "x" }] }, ctx({ breakpoints: [{ at: "last-message", ttl: "2h" as "5m" }] })), "breakpoints");
  // markers the caller already had are replaced, not kept
  const had = p.prepare({ model: "m", system: [{ type: "text", text: text(1000), cache_control: { type: "ephemeral" } }], messages: [{ role: "user", content: [{ type: "text", text: "q", cache_control: { type: "ephemeral" } }] }] }, ctx({ breakpoints: [{ at: "system-end", ttl: "5m" }] }));
  assert.equal(JSON.stringify(had.body).split("cache_control").length - 1, 1);
  // a last block that is thinking cannot carry a marker; the one before it does
  const thinking = p.prepare({ model: "m", system: text(1000), messages: [{ role: "assistant", content: [{ type: "text", text: text(300) }, { type: "thinking", thinking: "t", signature: "s" }] }, { role: "user", content: "x" }] }, ctx({ breakpoints: [{ at: { message: 0 }, ttl: "5m" }] }));
  const m0 = (thinking.body["messages"] as { content: { type: string; cache_control?: unknown }[] }[])[0]!.content;
  assert.deepEqual([m0[0]!.cache_control !== undefined, m0[1]!.cache_control], [true, undefined]);
});

test("Claude: the model's minimum decides whether a breakpoint is placed; an unlisted model assumes the highest", () => {
  const body = (tokens: number): WireRequest => ({ model: "m", system: text(tokens), messages: [{ role: "user", content: "q" }] });
  const placed = (model: string, tokens: number): number => profileFor({ kind: "claude", model }).prepare(body(tokens), ctx({ breakpoints: [{ at: "system-end", ttl: "5m" }] })).applied.length;
  assert.equal(CLAUDE_MIN_TOKENS["claude-opus-4-6"], 4096);
  assert.deepEqual([placed("claude-opus-5-5", 600), placed("claude-opus-5-5", 400)], [1, 0]);
  assert.deepEqual([placed("claude-opus-4-8", 1100), placed("claude-opus-4-8", 900)], [1, 0]);
  assert.deepEqual([placed("claude-opus-4-7", 2100), placed("claude-opus-4-7", 1900)], [1, 0]);
  assert.deepEqual([placed("claude-haiku-4-5", 4200), placed("claude-haiku-4-5", 3000)], [1, 0]);
  assert.deepEqual([placed("claude-future-9", 4200), placed("claude-future-9", 3000)], [1, 0], "unlisted: highest minimum");
  assert.match(profileFor({ kind: "claude", model: "claude-future-9" }).basis, /not in the minimum table/);
  const small = profileFor({ kind: "claude", model: "claude-haiku-4-5" }).prepare(body(100), ctx());
  assert.deepEqual([small.applied, small.expects], [[], "no"]);
  assert.match(small.skipped.join(), /under the 4096-token minimum for claude-haiku-4-5/);
  assert.equal(profileFor({ kind: "claude", model: "claude-haiku-4-5", options: { minPrefixTokens: 50 } }).prepare(body(100), ctx({ breakpoints: [{ at: "system-end", ttl: "5m" }] })).applied.length, 1);
});

test("Claude: hits from cache_read_input_tokens, with writes split by lifetime; total input is the sum of the three counts", () => {
  const p = profileFor({ kind: "claude", model: "claude-opus-5-5" });
  const shape = { id: "msg_1", type: "message", usage: { input_tokens: 25, cache_creation_input_tokens: 1000, cache_read_input_tokens: 8000, cache_creation: { ephemeral_5m_input_tokens: 400, ephemeral_1h_input_tokens: 600 }, output_tokens: 90 } };
  assert.deepEqual(p.read(shape), { known: true, source: "usage.cache_read_input_tokens", promptTokens: 9025, cachedTokens: 8000, computedTokens: 1025, writtenTokens: 1000, writtenByTtl: { fiveMinute: 400, oneHour: 600 } });
  assert.deepEqual([p.read({ usage: { input_tokens: 25, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } }).known, p.read({ usage: { input_tokens: 25 } }).known], [true, false]);
  assert.equal(p.read({ usage: { input_tokens: 25, cache_read_input_tokens: 5 } }).writtenTokens, 0);
  assert.equal(p.refusedCacheSetting({ status: 400, message: "cache_control.ttl: invalid" }), true);
  assert.equal(p.refusedCacheSetting({ status: 429, message: "cache_control" }), false);
  assert.deepEqual([p.capabilities.pin.level, p.capabilities.retention.control, p.capabilities.retention.maxMs, p.capabilities.prefixReuse], ["unsupported", "request", 3_600_000, "markers"]);
});

test("pin, fork and decoder resume are advertised separately, and nothing claims to be qualified or to resume a decoder", () => {
  const all = BACKEND_KINDS.map((kind) => profileFor({ kind, model: "m", options: { slots: 2, slotSave: true, pinPrefix: true } }));
  for (const p of all) {
    assert.equal(p.capabilities.decoderResume.level, "unsupported", p.kind);
    for (const s of [p.capabilities.pin, p.capabilities.fork, p.capabilities.slotSaveRestore]) assert.notEqual(s.level, "qualified", `${p.kind}: nothing is qualified before G10`);
  }
  const by = Object.fromEntries(all.map((p) => [p.kind, [p.capabilities.pin.level, p.capabilities.fork.level, p.capabilities.slotSaveRestore.level]]));
  assert.deepEqual(by["llama-cpp"], ["available", "available", "available"]);
  assert.deepEqual(by["strata"], ["available", "available", "available"]);
  assert.deepEqual(by["vllm"], ["unsupported", "available", "unsupported"]);
  assert.deepEqual(by["radiance"], ["unsupported", "available", "unsupported"]);
  assert.deepEqual(by["claude"], ["unsupported", "available", "unsupported"]);
});

test("negotiation says what is granted, what is not, and what happens instead", () => {
  const llama = negotiate(profileFor({ kind: "llama-cpp", model: "m", options: { slotSave: true } }), ["prefix-reuse", "pin", "fork", "slot-save-restore", "decoder-resume", "isolation"]);
  assert.deepEqual(Object.keys(llama.granted).sort(), ["fork", "pin", "prefix-reuse", "slot-save-restore"]);
  assert.match(llama.fallbacks["decoder-resume"]!, /full context/);
  assert.match(llama.fallbacks["isolation"]!, /cannot keep projects/);
  assert.deepEqual([...llama.unqualified].sort(), ["fork", "pin", "prefix-reuse", "slot-save-restore"]);
  const generic = negotiate(profileFor({ model: "m" }), ["prefix-reuse", "pin", "retention-control"]);
  assert.deepEqual([Object.keys(generic.granted), Object.keys(generic.fallbacks).length], [[], 3]);
  const claude = negotiate(profileFor({ kind: "claude", model: "claude-opus-5-5" }), ["retention-control", "isolation"]);
  assert.match(claude.granted["retention-control"]!, /5m.*1h/);
  refuses(() => negotiate(profileFor({ model: "m" }), ["teleport" as "pin"]), "wants");
});

test("derived keys: stable, scoped, secret-dependent, and free of the names they were made of", () => {
  const a = deriveKey("installation-secret-0123", "scope", "proj-a");
  assert.equal(a, deriveKey("installation-secret-0123", "scope", "proj-a"));
  assert.notEqual(a, deriveKey("installation-secret-0123", "scope", "proj-b"));
  assert.notEqual(a, deriveKey("another-secret-4567-89", "scope", "proj-a"));
  assert.notEqual(a, deriveKey("installation-secret-0123", "share", "proj-a"));
  assert.notEqual(deriveKey("installation-secret-0123", "share", "ab", "c"), deriveKey("installation-secret-0123", "share", "a", "bc"), "parts cannot run together");
  assert.match(a, /^nn-[A-Za-z0-9_-]{27}$/);
  assert.ok(!a.includes("proj"));
  refuses(() => deriveKey("short", "scope", "x"), "secret");
  refuses(() => deriveKey("installation-secret-0123", "scope"), "parts");
  refuses(() => deriveKey("installation-secret-0123", "scope", ""), "parts");
});

test("Claude: cache_control is removed only where the API takes it; the model's own data is never touched, on prepare or on the plain fallback", () => {
  const p = profileFor({ kind: "claude", model: "claude-opus-5-5" });
  const request = (): WireRequest => ({
    model: "m",
    tools: [{ name: "t", description: "d", cache_control: { type: "ephemeral" }, input_schema: { type: "object", properties: { cache_control: { type: "string" }, other: { type: "string" } }, required: ["cache_control"] } }],
    system: [{ type: "text", text: text(900), cache_control: { type: "ephemeral" } }],
    messages: [
      { role: "user", content: [{ type: "text", text: "run it", cache_control: { type: "ephemeral" } }] },
      { role: "assistant", content: [{ type: "tool_use", id: "tu1", name: "t", input: { cache_control: "no-store", nested: { cache_control: { keep: true } } } }] },
      { role: "user", content: [{ type: "tool_result", tool_use_id: "tu1", cache_control: { type: "ephemeral" }, content: [{ type: "text", text: 'the file says {"cache_control": "x"}', cache_control: { type: "ephemeral" } }] }] },
      { role: "user", content: [{ type: "tool_result", tool_use_id: "tu1", content: '{"cache_control": "no-store"}' }] },
    ],
  });
  for (const ctxExtra of [{}, { plain: true }]) {
    const out = p.prepare(request(), ctx({ ...ctxExtra, breakpoints: [{ at: "system-end", ttl: "5m" }] })).body as { tools: { input_schema: Record<string, unknown>; cache_control?: unknown }[]; messages: { content: unknown[] | string }[] };
    assert.deepEqual(out.tools[0]!.input_schema, { type: "object", properties: { cache_control: { type: "string" }, other: { type: "string" } }, required: ["cache_control"] }, "the schema's property and required entry both survive");
    const useBlock = out.messages[1]!.content[0] as { input: unknown };
    assert.deepEqual(useBlock.input, { cache_control: "no-store", nested: { cache_control: { keep: true } } }, "a tool_use input is the model's data");
    const result = out.messages[2]!.content[0] as { content: { text: string; cache_control?: unknown }[]; cache_control?: unknown };
    assert.equal(result.content[0]!.text, 'the file says {"cache_control": "x"}', "text is never rewritten");
    assert.equal(out.messages[3]!.content[0] && (out.messages[3]!.content[0] as { content: string }).content, '{"cache_control": "no-store"}');
    // markers the caller had at the places the API takes them are replaced (or, on the plain request, gone)
    assert.equal(result.cache_control, undefined);
    assert.equal(result.content[0]!.cache_control, undefined);
    assert.equal(out.tools[0]!.cache_control, undefined);
  }
});

test("a refusal is recognised by the field we sent as a whole word, in a 400 or a 422, and not by lookalike words", () => {
  const claude = profileFor({ kind: "claude", model: "claude-opus-5-5" });
  const llama = profileFor({ kind: "llama-cpp", model: "m" });
  for (const message of ["a little too long", "please settle the bill", "the prompt is too long: n_ctx_slot is 4096", "rate limited, retry later", "maximum context length exceeded"]) {
    assert.equal(claude.refusedCacheSetting({ status: 400, message }), false, message);
    assert.equal(llama.refusedCacheSetting({ status: 400, message }), false, message);
  }
  assert.equal(llama.refusedCacheSetting({ status: 400, message: "request exceeds the available context size, n_ctx_slot = 4096" }), false);
  assert.equal(claude.refusedCacheSetting({ status: 400, message: "cache_control.ttl: invalid" }), true);
  assert.equal(claude.refusedCacheSetting({ status: 400, message: "messages.0.content.0.cache_control: extra" }), true);
  assert.equal(llama.refusedCacheSetting({ status: 400, message: "unknown field id_slot" }), true);
  assert.equal(llama.refusedCacheSetting({ status: 422, message: '[{"type":"extra_forbidden","loc":["body","cache_prompt"],"msg":"Extra inputs are not permitted"}]' }), true);
  assert.equal(profileFor({ kind: "vllm", model: "m" }).refusedCacheSetting({ status: 422, message: '[{"type":"extra_forbidden","loc":["body","cache_salt"]}]' }), true);
  assert.equal(llama.refusedCacheSetting({ status: 422, message: '[{"type":"missing","loc":["body","messages"]}]' }), false);
  assert.equal(llama.refusedCacheSetting({ status: 500, message: "id_slot" }), false);
  assert.equal(profileFor({ kind: "strata", model: "m" }).refusedCacheSetting({ status: 400, message: "strata_checkpoint must be a boolean" }), true);
  assert.equal(profileFor({ kind: "strata", model: "m" }).refusedCacheSetting({ status: 400, message: "strata_other" }), false);
  assert.equal(profileFor({ kind: "openai", model: "m" }).refusedCacheSetting({ status: 400, message: "Unknown parameter: 'prompt_cache_retention'." }), true);
  assert.equal(profileFor({ kind: "openai", model: "m" }).refusedCacheSetting({ status: 400, message: "invalid retention of messages" }), false);
});

test("a project that requires isolation gets no cache settings where the backend cannot keep projects apart", () => {
  const req = (): WireRequest => ({ model: "m", system: text(1000), messages: [{ role: "user", content: "q" }] });
  const iso = ctx({ isolationRequired: true, slot: 0, retention: "long", prefixTokens: 5000 });
  const llama = profileFor({ kind: "llama-cpp", model: "m", options: { slots: 2 } }).prepare(req(), iso);
  assert.deepEqual([llama.body["cache_prompt"], llama.body["id_slot"], llama.expects, llama.applied], [false, undefined, "no", ["cache_prompt=false"]]);
  assert.match(llama.skipped.join(), /requires isolation/);
  for (const config of [{ kind: "radiance", model: "m" }, { kind: "openai", model: "m", options: { extendedRetention: true } }, { kind: "openai-compatible", model: "m", options: { promptCacheKey: true } }, { kind: "claude", model: "claude-opus-5-5" }, { model: "m" }] as EndpointConfig[]) {
    const out = profileFor(config).prepare(req(), { ...iso, pinMessages: 1 });
    assert.deepEqual([out.applied, out.expects], [[], "no"], config.kind ?? "generic");
    assert.ok(!JSON.stringify(out.body).includes("cache_control") && !("prompt_cache_key" in out.body) && !("session_id" in out.body) && !("strata_prefix" in out.body), config.kind ?? "generic");
  }
  // Strata cannot switch reuse off: it leaves no checkpoint and no pin behind, and says that only a route of its own isolates
  const strata = profileFor({ kind: "strata", model: "m", options: { pinPrefix: true } }).prepare(req(), { ...iso, pinMessages: 1, pinAuthorized: true });
  assert.deepEqual([strata.applied, strata.body["strata_checkpoint"], strata.body["strata_prefix"], strata.expects], [["strata_checkpoint=false"], false, undefined, "no"]);
  assert.match(strata.skipped.join(), /only a route of its own isolates/);
  // a backend that can isolate keeps working normally, and without the requirement nothing changes
  assert.equal(profileFor({ kind: "vllm", model: "m" }).prepare(req(), iso).body["cache_salt"], scope);
  assert.equal(profileFor({ kind: "llama-cpp", model: "m", options: { slots: 2 } }).prepare(req(), ctx({ slot: 0 })).body["cache_prompt"], true);
  assert.equal(profileFor({ kind: "openai", model: "m" }).capabilities.isolation, "none", "prompt_cache_key is a routing hint, not a partition");
  assert.equal(profileFor({ kind: "openai-compatible", model: "m", options: { promptCacheKey: true } }).capabilities.isolation, "none");
});

test("default lifetimes follow the backend's real one, and an endpoint may name the route it serves", () => {
  const life = (config: EndpointConfig) => profileFor(config).defaultLifetimeMs;
  assert.deepEqual([life({ kind: "claude", model: "claude-opus-5-5" }), life({ kind: "openai", model: "m" }), life({ kind: "openai", model: "m", options: { extendedRetention: true } }), life({ kind: "openai-compatible", model: "m" })], [300_000, 300_000, 86_400_000, 300_000]);
  assert.deepEqual([life({ kind: "llama-cpp", model: "m" }), life({ kind: "radiance", model: "m" }), life({ model: "m" })], [3_600_000, 3_600_000, undefined]);
  refuses(() => profileFor({ kind: "vllm", model: "m", route: "not a route" }), "endpoint.route");
  assert.equal(profileFor({ kind: "vllm", model: "m", route: "local/qwen" }).kind, "vllm");
});

test("slot affinity: a group keeps its slot, new groups take free slots, the least recently used loses its slot", () => {
  const s = new SlotAffinity(2);
  assert.deepEqual(s.assign("p", "a"), { slot: 0 });
  assert.deepEqual(s.assign("p", "b"), { slot: 1 });
  assert.deepEqual(s.assign("p", "a"), { slot: 0 });
  assert.deepEqual(s.assign("p", "c"), { slot: 1, evicted: "b" });
  assert.deepEqual(s.assign("p", "a"), { slot: 0 });
  s.release("p", "a");
  assert.deepEqual(s.assign("p", "d"), { slot: 0 });
  refuses(() => new SlotAffinity(0), "slots");
  // a project never takes another project's slot
  const two = new SlotAffinity(2);
  assert.deepEqual([two.assign("p1", "a"), two.assign("p1", "b")], [{ slot: 0 }, { slot: 1 }]);
  assert.match((two.assign("p2", "x") as { refused: string }).refused, /another project/);
  assert.deepEqual(two.assign("p1", "c"), { slot: 0, evicted: "a" }, "its own least recently used group gives way");
  assert.deepEqual(two.assign("p1", "b"), { slot: 1 });
  two.release("p1", "b"); two.release("p1", "c");
  assert.deepEqual(two.assign("p2", "x"), { slot: 0 }, "slots freed by one project are free for another");
  assert.deepEqual(two.assign("p1", "same-name"), { slot: 1 });
  assert.deepEqual(two.assign("p3", "same-name"), { refused: "every slot belongs to another project; a project does not take another's slot" }, "groups are keyed by project too");
});
