import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { CacheAdapter, profileFor } from "@nimblenewt/controller";
import { flattenMessages, hermesResponse, HermesTransport, readHermesUsage, syntheticHead, type HermesRunner } from "./g10-hermes-route.js";

// Card G10, hosted OpenAI route through Hermes: the production profile and CacheAdapter re-tested against usage reports captured on 2026-11-25 (see test-fixtures/g10-hermes-openai-codex/README.md).
const DIR = fileURLToPath(new URL("../test-fixtures/g10-hermes-openai-codex/", import.meta.url));
interface Fixture { readonly step: string; readonly usage: unknown; readonly answer: string; readonly expected: string }
const fx = (name: string): Fixture => JSON.parse(readFileSync(join(DIR, `${name}.json`), "utf8")) as Fixture;
const replay = (name: string): HermesRunner => async () => ({ text: fx(name).answer, usage: fx(name).usage, wallMs: 1, exitCode: 0 });
const profile = () => profileFor({ kind: "openai", model: "gpt-6.1-sol", options: {} });
const totalOf = (u: { input_tokens: number; cache_read_tokens: number }): number => u.input_tokens + u.cache_read_tokens;

test("captured Hermes usage reports read through the production OpenAI profile: the total is uncached input plus cache read, and the answer depends on early context", async () => {
  const names = readdirSync(DIR).filter((f) => f.endsWith(".json")).map((f) => f.slice(0, -5));
  assert.equal(names.length, 11);
  for (const name of names) {
    const f = fx(name); const usage = readHermesUsage(f.usage)!;
    assert.ok(usage, name);
    assert.equal(usage.provider, "openai-codex"); assert.equal(usage.completed, true);
    const transport = new HermesTransport(replay(name));
    const res = await new CacheAdapter(profile(), transport).call({ messages: [{ role: "system", content: "s" }, { role: "user", content: "q" }] }, { scopeKey: "nn-scope0123456789", shareKey: "nn-share0123456789" }, 0);
    assert.equal(res.status, 200, name);
    assert.equal(res.hit.known, true, name);
    assert.equal(res.hit.source, "usage.prompt_tokens_details.cached_tokens");
    assert.equal(res.hit.promptTokens, totalOf(usage), name);
    assert.equal(res.hit.cachedTokens, usage.cache_read_tokens, name);
    assert.equal(res.hit.computedTokens, usage.input_tokens, name);
    assert.ok(f.answer.toLowerCase().includes(f.expected.toLowerCase()), `${name}: the answer still depends on the fact placed early in the prompt`);
    assert.deepEqual(transport.calls[0]!.dropped, ["prompt_cache_key"], `${name}: the production profile's key is not carried by this route`);
    assert.equal(JSON.stringify(f).includes("session_id"), false, name);
  }
});

test("measured shape of the route: an identical repeat is not reliably served from cache, a resumed session is", () => {
  const read = (n: string) => readHermesUsage(fx(n).usage)!;
  // Same prompt again, started as a new Hermes session: the cached part stays at Hermes's own small prefix in both repeats (the head was not reused), and one idle probe did not change that.
  assert.equal(read("r1-repeat").cache_read_tokens, read("r1-cold").cache_read_tokens);
  assert.equal(read("r2-repeat").cache_read_tokens, read("r2-cold").cache_read_tokens);
  // The cached part jumps to at most Hermes's own prefix on some calls with no relation to the head (not the shared head; why those calls got it is not visible): a changed head also saw it.
  assert.ok(read("r1-changed-head").cache_read_tokens > 15_000 && read("r2-fork").cache_read_tokens > 15_000);
  // A resumed session (one provider cache scope, same prefix plus a short question): nearly everything is served from cache.
  const second = read("resume-second");
  assert.ok(second.cache_read_tokens / totalOf(second) > 0.99);
  assert.equal(read("resume-first").cache_read_tokens < 5_000, true);
  assert.equal(fx("resume-second").answer, fx("resume-second").expected);
});

test("a cache-miss expectation is judged by the production adapter, and a failed or unreadable run is a failed response, not a zero", async () => {
  const ctx = { scopeKey: "nn-scope0123456789", shareKey: "nn-share0123456789" };
  const req = { messages: [{ role: "user", content: "q" }] };
  const miss = await new CacheAdapter(profile(), new HermesTransport(replay("r2-repeat"))).call(req, ctx, 15_000);
  assert.equal(miss.outcome, "partial");
  const hit = await new CacheAdapter(profile(), new HermesTransport(replay("resume-second"))).call(req, ctx, 15_000);
  assert.equal(hit.outcome, "hit");
  const bad = new HermesTransport(async () => ({ text: "", usage: { garbage: true }, wallMs: 1, exitCode: 0 }));
  assert.equal((await new CacheAdapter(profile(), bad).call(req, ctx, 0)).status, 502);
  const failed = new HermesTransport(async () => ({ text: "", usage: fx("r1-cold").usage, wallMs: 1, exitCode: 1 }));
  assert.equal((await new CacheAdapter(profile(), failed).call(req, ctx, 0)).status, 502);
});

test("converters: usage reports with wrong types are refused, the flattened prompt keeps a system text first and unprefixed, heads are deterministic given the random source", () => {
  assert.equal(readHermesUsage({ ...(fx("r1-cold").usage as object), cache_read_tokens: "3" }), undefined);
  assert.equal(readHermesUsage(null), undefined);
  assert.equal(flattenMessages([{ role: "system", content: "S" }, { role: "user", content: [{ text: "a" }, { text: "b" }] }, { role: "assistant", content: "c" }]), "S\n\nuser: ab\n\nassistant: c");
  assert.equal(flattenMessages("nope"), "");
  const r = hermesResponse(readHermesUsage(fx("r1-cold").usage)!, "x");
  assert.deepEqual((r.usage as { prompt_tokens_details: unknown }).prompt_tokens_details, { cached_tokens: 3968 });
  const a = syntheticHead("n1", 40, () => 1); const b = syntheticHead("n2", 40, () => 1);
  assert.equal(a.code, "cobalt-101"); assert.equal(a.team, "Heron");
  assert.ok(a.text.startsWith("Run n1.") && b.text.startsWith("Run n2.") && a.text.includes(`vault code for this run is ${a.code}`) && a.text.includes(`on-call team for this run is ${a.team}`));
});

test("the figures stated in the implementation notes are the ones in the fixtures", () => {
  const read = (n: string) => readHermesUsage(fx(n).usage)!;
  const bench = ["r1-cold", "r1-repeat", "r1-fork", "r1-changed-head", "r1-after-idle-330s", "r2-cold", "r2-repeat", "r2-fork", "r2-changed-head"];
  // New session, same prompt: 3,968 and 3,712 cached, cold and repeat alike.
  assert.deepEqual([read("r1-cold").cache_read_tokens, read("r1-repeat").cache_read_tokens, read("r2-cold").cache_read_tokens, read("r2-repeat").cache_read_tokens], [3968, 3968, 3712, 3712]);
  // 19,840 cached on exactly two of the nine bench calls (repeat 1 changed head, repeat 2 fork); the idle repeat showed only the small prefix.
  assert.deepEqual(bench.filter((n) => read(n).cache_read_tokens === 19_840), ["r1-changed-head", "r2-fork"]);
  assert.equal(read("r1-after-idle-330s").cache_read_tokens, 3968);
  // Every prompt about 24,300 tokens; no bench call had more than 19,840 served from cache (the synthetic head was never reused).
  for (const n of [...bench, "resume-first", "resume-second"]) { const t = totalOf(read(n)); assert.ok(t > 24_300 && t < 24_400, n); }
  assert.ok(bench.every((n) => read(n).cache_read_tokens <= 19_840));
  // Resumed session: 24,192 of 24,358 (99.3%, 166 computed).
  assert.deepEqual([read("resume-second").cache_read_tokens, totalOf(read("resume-second")), read("resume-second").input_tokens], [24_192, 24_358, 166]);
  assert.equal(Math.round((1000 * 24_192) / 24_358) / 10, 99.3);
  // 11 answers, 11 right; provider calls in the kept runs: 10 runs of 2 (answer and title) and the resumed one of 1 = 21 (the first probe's 2 make the notes' 23; it was not kept).
  assert.equal(bench.length + 2, 11);
  const calls = [...bench, "resume-first", "resume-second"].reduce((s, n) => s + read(n).api_calls + (read(n).auxiliary?.api_calls ?? 0), 0);
  assert.equal(calls, 21);
});
