import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { CacheAdapter, type HttpRequest, type HttpResponse, type Transport } from "./adapter.js";
import type { CacheProfile } from "./profile.js";
import { profileFor } from "./profiles.js";

// Card G10, second run: the Radiance profile (C06) and the production CacheAdapter re-tested against responses captured from the running server on 2026-11-25 (version 2.2.0, shared with other clients) by
// packages/integration/src/g10-radiance-live-bench.ts. See ../../test-fixtures/g10-radiance-live/README.md. Nothing here calls a server.

const DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "test-fixtures", "g10-radiance-live");
interface Fixture { readonly status: number; readonly body: unknown }
const load = (name: string): Fixture => JSON.parse(readFileSync(join(DIR, `${name}.json`), "utf8")) as Fixture;
const profile = (): CacheProfile => profileFor({ kind: "radiance", model: "qwen3.8-flash-next-iq4r", options: { hostTier: true, hybrid: true } });
const usageOf = (b: unknown): { prompt_tokens: number; prompt_tokens_details: { cached_tokens: number } } => (b as { usage: { prompt_tokens: number; prompt_tokens_details: { cached_tokens: number } } }).usage;
const STEP = 2048;
const ctx = { scopeKey: "nn-scope0123456789", shareKey: "nn-share0123456789" };
const request = { messages: [{ role: "system", content: "head" }, { role: "user", content: "q" }] };
/** Replays the given responses in order and keeps what was sent. */
const replay = (...responses: Fixture[]): { transport: Transport; seen: HttpRequest[] } => {
  const seen: HttpRequest[] = []; let i = 0;
  return { seen, transport: { send: async (r): Promise<HttpResponse> => { seen.push(r); const f = responses[Math.min(i++, responses.length - 1)]!; return { status: f.status, body: f.body }; } } };
};

test("every captured 200: hits are read from timings.cache_n and prompt_n, agree with the usage field, stop at a snapshot step, and the usage-only fallback gives the same figures", () => {
  const names = readdirSync(DIR).filter((f) => f.endsWith(".json")).map((f) => f.slice(0, -5));
  const served = names.filter((n) => load(n).status === 200);
  assert.ok(served.length >= 12, `captured responses: ${served.length}`);
  const p = profile();
  for (const name of served) {
    const body = load(name).body;
    const hit = p.read(body);
    const usage = usageOf(body);
    assert.deepEqual([hit.known, hit.source], [true, "timings.cache_n + timings.prompt_n"], name);
    assert.equal(hit.promptTokens, usage.prompt_tokens, `${name}: cache_n + prompt_n is the whole prompt`);
    assert.equal(hit.cachedTokens, usage.prompt_tokens_details.cached_tokens, `${name}: the two hit fields agree`);
    assert.equal(hit.cachedTokens % STEP, 0, `${name}: reuse stops at a snapshot boundary`);
    const { timings: _t, ...withoutTimings } = body as Record<string, unknown>;
    const fallback = p.read(withoutTimings);
    assert.deepEqual([fallback.source, fallback.promptTokens, fallback.cachedTokens], ["usage.prompt_tokens_details.cached_tokens", hit.promptTokens, hit.cachedTokens], name);
  }
  // The figures the evidence quotes.
  const cached = (n: string): number => profile().read(load(n).body).cachedTokens;
  assert.deepEqual(["retained-cold", "retained-native", "retained-hit-after-0s", "retained-hit-after-15s", "retained-hit-after-30s", "retained-hit-switch-back", "retained-miss-after-60s", "retained-miss-changed-head"].map(cached), [0, 8192, 8192, 8192, 8192, 8192, 0, 0]);
  assert.deepEqual(["concurrency-8-cold", "concurrency-8-repeat", "concurrency-after-load-miss"].map(cached), [0, 6144, 0]);
});

test("a marker-driven retained run through the production adapter: the marker's expected tokens judge the captured responses hit after 0, 15 and 30 s and on a switch back, and miss after 60 s and on a changed head", async () => {
  const expected = profile().read(load("retained-native").body).cachedTokens;
  assert.equal(expected, 8192);
  for (const [name, outcome] of [["retained-hit-after-0s", "hit"], ["retained-hit-after-15s", "hit"], ["retained-hit-after-30s", "hit"], ["retained-hit-switch-back", "hit"], ["retained-miss-after-60s", "miss"], ["retained-miss-changed-head", "miss"]] as const) {
    const { transport, seen } = replay(load(name));
    const res = await new CacheAdapter(profile(), transport).call(request, ctx, expected);
    assert.equal(res.outcome, outcome, name);
    assert.equal(res.hit.promptTokens > res.hit.cachedTokens, true, "the tail is always computed");
    assert.deepEqual(seen.map((s) => s.body["session_id"]), ["nn-share0123456789"], "only the label is sent");
  }
  // Cold and native, kept apart: the first call of a head is cold (nothing was expected), the repeat is a hit.
  assert.equal((await new CacheAdapter(profile(), replay(load("retained-cold")).transport).call(request, ctx, 0)).outcome, "cold");
  assert.equal((await new CacheAdapter(profile(), replay(load("retained-native")).transport).call(request, ctx, 1)).outcome, "hit");
});

/** The wrapper G10's live run used: the production Radiance profile plus one setting the server does not implement, named as refused by its own error text. */
function refusing(): CacheProfile {
  const base = profile();
  return {
    ...base,
    prepare: (r, c) => { const p = base.prepare(r, c); return c.plain === true ? p : { ...p, body: { ...p.body, logit_bias: { "50256": -1 } }, applied: [...p.applied, "logit_bias"] }; },
    refusedCacheSetting: (f) => (f.status === 400 || f.status === 422) && /\blogit_bias\b/.test(f.message.toLowerCase()),
  };
}

test("the captured real refusal: the adapter retries with every cache setting removed and the same messages, records the fallback, and the retried call is read as served from cache", async () => {
  const refusal = load("refusal-logit_bias");
  assert.deepEqual([refusal.status, (refusal.body as { error: { code: string; param: string } }).error.code, (refusal.body as { error: { param: string } }).error.param], [400, "unsupported_parameter", "logit_bias"]);
  for (const served of ["refusal-fallback-served", "refusal-fallback-second-question"]) {
    const { transport, seen } = replay(refusal, load(served));
    const res = await new CacheAdapter(refusing(), transport).call(request, ctx, 8192);
    assert.equal(seen.length, 2);
    assert.deepEqual(seen[0]!.body["logit_bias"], { "50256": -1 });
    assert.equal(seen[1]!.body["logit_bias"], undefined);
    assert.equal(seen[1]!.body["session_id"], undefined, "the retry carries no cache setting at all");
    assert.deepEqual(seen[1]!.body["messages"], seen[0]!.body["messages"], "the same messages went again: no context was lost");
    assert.deepEqual([res.status, res.outcome, res.hit.cachedTokens, res.fallback?.refusedStatus, res.fallback?.removed], [200, "hit", 8192, 400, ["session_id", "logit_bias"]], served);
    assert.match(res.fallback?.reason ?? "", /logit_bias/);
  }
  // The production Radiance profile does not claim this refusal: it names a setting the profile never sends.
  assert.equal(profile().refusedCacheSetting({ status: 400, message: (refusal.body as { error: { message: string } }).error.message }), false);
});

test("a captured real 400 that names no cache setting is returned unchanged with no retry", async () => {
  const other = load("refusal-other-400");
  assert.equal(other.status, 400);
  const { transport, seen } = replay(other, load("refusal-warm-native"));
  const res = await new CacheAdapter(profile(), transport).call({ ...request, temperature: "hot" }, ctx, 0);
  assert.deepEqual([res.status, res.fallback, res.outcome, seen.length], [400, undefined, "unknown", 1]);
  // The wrapper does not take it for its own either.
  const again = replay(other, load("refusal-warm-native"));
  const wrapped = await new CacheAdapter(refusing(), again.transport).call({ ...request, temperature: "hot" }, ctx, 0);
  assert.deepEqual([wrapped.status, wrapped.fallback, again.seen.length], [400, undefined, 1]);
});
