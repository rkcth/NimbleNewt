import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { CacheAdapter, profileFor } from "@nimblenewt/controller";
import { flattenMessages, hermesResponse, HermesTransport, readHermesUsage, syntheticHead, type HermesRunner } from "./g10-hermes-route.js";

// Card G10, hosted OpenAI route through Hermes: the production profile and CacheAdapter re-tested against usage reports captured on 2026-11-25 (see test-fixtures/g10-hermes-openai-codex/README.md).
const DIR = fileURLToPath(new URL("../test-fixtures/g10-hermes-openai-codex/", import.meta.url));
interface Fixture { readonly step: string; readonly usage: unknown; readonly answer: string; readonly expected: string }
const fx = (name: string): Fixture => JSON.parse(readFileSync(`${DIR}${name}.json`, "utf8")) as Fixture;
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
  // The cached part jumps to about the whole Hermes prefix on some calls with no relation to the head (routing, not the shared head): a changed head also saw it.
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
