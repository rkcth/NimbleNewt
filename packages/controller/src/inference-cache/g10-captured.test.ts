import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { responseBody } from "../dispatch/pi-fetch.js";
import { CacheAdapter, type HttpRequest, type HttpResponse, type Transport } from "./adapter.js";
import { profileFor } from "./profiles.js";

// Card G10: the Radiance profile (C06) re-tested against responses captured from the owner's running Radiance 2.1.0 server (qwen3.8-flash-next, a hybrid model) on 2026-11-16 by
// packages/integration/src/g10-radiance-bench.ts. See ../test-fixtures/g10-radiance/README.md for how each file was captured. The streamed files hold the server's own last events (the
// finish event with `timings`, the usage event with `usage` and `timings`), read here through the production stream reader (`responseBody`, used by pi-fetch).

const DIR = fileURLToPath(new URL("../../test-fixtures/g10-radiance/", import.meta.url));
const sse = (name: string): unknown => responseBody(readFileSync(`${DIR}${name}`, "utf8"), true);
const json = (name: string): unknown => JSON.parse(readFileSync(`${DIR}${name}`, "utf8")) as unknown;
const profile = () => profileFor({ kind: "radiance", model: "qwen3.8-flash-next-iq4r", options: { hostTier: true, hybrid: true } });
const usageOf = (body: unknown): { prompt_tokens: number; prompt_tokens_details: { cached_tokens: number } } => (body as { usage: { prompt_tokens: number; prompt_tokens_details: { cached_tokens: number } } }).usage;
/** Hybrid-model reuse resumes at a linear-state snapshot, which this server writes every 2,048 tokens (measured: every hit was a multiple of 2,048). */
const SNAPSHOT_TOKENS = 2048;

test("captured Radiance responses: hits are read from timings.cache_n and prompt_n, and agree with the usage field the server also sends", () => {
  const p = profile();
  for (const [name, body] of [["cold.sse", sse("cold.sse")], ["repeat.sse", sse("repeat.sse")], ["changed-head.sse", sse("changed-head.sse")], ["repeat.json", json("repeat.json")]] as const) {
    const hit = p.read(body);
    const usage = usageOf(body);
    assert.equal(hit.known, true, name);
    assert.equal(hit.source, "timings.cache_n + timings.prompt_n", name);
    assert.equal(hit.promptTokens, usage.prompt_tokens, `${name}: cache_n + prompt_n is the whole prompt`);
    assert.equal(hit.cachedTokens, usage.prompt_tokens_details.cached_tokens, `${name}: the two hit fields agree`);
    assert.equal(hit.cachedTokens % SNAPSHOT_TOKENS, 0, `${name}: reuse stops at a snapshot boundary`);
    assert.match(hit.caveat ?? "", /hybrid/);
    // Without timings (a proxy that drops them) the profile falls back to the usage field and gets the same figures.
    const { timings: _t, ...withoutTimings } = body as Record<string, unknown>;
    const fallback = p.read(withoutTimings);
    assert.deepEqual([fallback.known, fallback.source, fallback.promptTokens, fallback.cachedTokens], [true, "usage.prompt_tokens_details.cached_tokens", hit.promptTokens, hit.cachedTokens], name);
  }
  assert.equal(p.read(sse("cold.sse")).cachedTokens, 0, "the first call of a new head computes everything");
  assert.ok(p.read(sse("repeat.sse")).cachedTokens > 0, "the same head again is served from cache");
  assert.equal(p.read(sse("changed-head.sse")).cachedTokens, 0, "one changed word at the start computes everything again");
  assert.deepEqual([p.minPrefixTokens, profileFor({ kind: "radiance", model: "m", options: { hybrid: false } }).minPrefixTokens, profileFor({ kind: "radiance", model: "m", options: { minPrefixTokens: 4096 } }).minPrefixTokens], [SNAPSHOT_TOKENS, 1, 4096]);
});

test("captured Radiance responses through the production CacheAdapter: cold, hit and miss are judged as the dispatcher would see them, and only session_id is sent", async () => {
  const replies = new Map<string, unknown>([["cold", sse("cold.sse")], ["repeat", sse("repeat.sse")], ["changed", sse("changed-head.sse")]]);
  const seen: HttpRequest[] = [];
  let next = "cold";
  const replay: Transport = { send: async (r): Promise<HttpResponse> => { seen.push(r); return { status: 200, body: replies.get(next) }; } };
  const adapter = new CacheAdapter(profile(), replay);
  const ctx = { scopeKey: "nn-scope0123456789", shareKey: "nn-share0123456789" };
  const request = { messages: [{ role: "user", content: "x" }], stream: true };
  const cold = await adapter.call(request, ctx, 0);
  next = "repeat";
  const repeat = await adapter.call(request, ctx, 1);
  next = "changed";
  const changed = await adapter.call(request, ctx, repeat.hit.cachedTokens);
  assert.deepEqual([cold.outcome, repeat.outcome, changed.outcome], ["cold", "hit", "miss"]);
  assert.deepEqual(seen.map((r) => r.body["session_id"]), ["nn-share0123456789", "nn-share0123456789", "nn-share0123456789"]);
  for (const r of seen) for (const ignored of ["cache_prompt", "id_slot", "prompt_cache_key"]) assert.equal(ignored in r.body, false, ignored);
});

test("a shared prefix under the measured 2,048-token step is not expected to be reused, so the captured cold answer under it is judged cold, not a miss", async () => {
  const p = profile();
  const ctx = { scopeKey: "nn-scope0123456789", shareKey: "nn-share0123456789" };
  const request = { messages: [{ role: "user", content: "x" }] };
  const under = p.prepare(request, { ...ctx, prefixTokens: 1_750 });
  assert.equal(under.expects, "no");
  assert.equal(under.body["session_id"], "nn-share0123456789", "the label is still sent");
  assert.ok(under.skipped.some((s) => /1750 tokens\) is under the 2048-token minimum/.test(s)), under.skipped.join("; "));
  for (const [prefixTokens, expects] of [[2_048, "yes"], [13_470, "yes"], [undefined, "yes"]] as const) assert.equal(p.prepare(request, { ...ctx, ...(prefixTokens === undefined ? {} : { prefixTokens }) }).expects, expects, String(prefixTokens));
  // A non-hybrid model has no step; the endpoint option still overrides.
  assert.equal(profileFor({ kind: "radiance", model: "m", options: { hybrid: false } }).prepare(request, { ...ctx, prefixTokens: 1_750 }).expects, "yes");
  assert.equal(profileFor({ kind: "radiance", model: "m", options: { minPrefixTokens: 4096 } }).prepare(request, { ...ctx, prefixTokens: 3_000 }).expects, "no");
  // Through the adapter with a reuse expected from an earlier call: zero cached under the step is cold; over it, a miss.
  const replay: Transport = { send: async (): Promise<HttpResponse> => ({ status: 200, body: sse("cold.sse") }) };
  const adapter = new CacheAdapter(p, replay);
  assert.equal((await adapter.call({ ...request, stream: true }, { ...ctx, prefixTokens: 1_750 }, 2_048)).outcome, "cold");
  assert.equal((await adapter.call({ ...request, stream: true }, { ...ctx, prefixTokens: 13_470 }, 2_048)).outcome, "miss");
});
